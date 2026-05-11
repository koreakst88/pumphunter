const axios = require('axios');
const WebSocket = require('ws');
const config = require('../config');
const exchange = require('./exchange');
const logger = require('../utils/logger');

const BYBIT_BASE_URL = 'https://api.bybit.com';
const BYBIT_WS_URL = 'wss://stream.bybit.com/v5/public/linear';
const BYBIT_WS_BATCH_SIZE = 100;
const BYBIT_WS_PING_INTERVAL_MS = 20_000;
const BYBIT_WS_RECONNECT_DELAY_MS = 5_000;
const PRICE_HISTORY_RETENTION_MS = 70 * 60 * 1000;
const CHANGE_1H_TARGET_MS = 60 * 60 * 1000;
const CHANGE_1H_MIN_AGE_MS = 55 * 60 * 1000;
const CHANGE_1H_MAX_AGE_MS = 65 * 60 * 1000;
const WARMUP_MS = 65 * 60 * 1000;
const SYMBOL_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const lastSignalSentAt = new Map();
const tickers = new Map();
const priceHistory = new Map();
const startTime = Date.now();

const bybitClient = axios.create({
  baseURL: BYBIT_BASE_URL,
  timeout: 30_000,
  headers: {
    'User-Agent': 'Mozilla/5.0',
    Accept: 'application/json',
  },
});

let scanTimer = null;
let symbolRefreshTimer = null;
let wsReconnectTimer = null;
let scanHandler = null;
let isFetchingTickers = false;
let lastTickerFetchAt = 0;
let bybitSymbols = new Set();
let wsShouldReconnect = false;
const wsConnections = new Set();
const wsPingTimers = new Map();

function getSignalCooldownMs() {
  return config.SIGNAL_COOLDOWN_HOURS * 60 * 60 * 1000;
}

function canSendSignal(symbol) {
  const sentAt = lastSignalSentAt.get(symbol);

  if (!sentAt) {
    return true;
  }

  return Date.now() - sentAt >= getSignalCooldownMs();
}

function markSignalSent(symbol) {
  lastSignalSentAt.set(symbol, Date.now());
}

function normalizeBybitTicker(ticker) {
  const symbol = ticker.symbol;
  const price = Number(ticker.lastPrice);
  const turnover24h = Number(ticker.turnover24h);
  const volume24h = Number(ticker.volume24h);
  const price24hPcnt = Number(ticker.price24hPcnt);
  const fundingRate = Number(ticker.fundingRate);
  const openInterest = Number(ticker.openInterest);
  const openInterestValue = Number(ticker.openInterestValue);

  if (
    !symbol
    || !symbol.endsWith('USDT')
    || !Number.isFinite(price)
    || price <= 0
  ) {
    return null;
  }

  return {
    symbol,
    price,
    price24hPcnt: Number.isFinite(price24hPcnt) ? price24hPcnt : 0,
    change24h: Number.isFinite(price24hPcnt) ? price24hPcnt * 100 : 0,
    volume24h: Number.isFinite(turnover24h) && turnover24h > 0
      ? turnover24h
      : Number.isFinite(volume24h)
        ? volume24h * price
        : 0,
    openInterest: Number.isFinite(openInterest) ? openInterest : 0,
    openInterestValue: Number.isFinite(openInterestValue) ? openInterestValue : 0,
    fundingRate: Number.isFinite(fundingRate) ? fundingRate * 100 : 0,
    updatedAt: Date.now(),
  };
}

function chunkArray(items, chunkSize) {
  const chunks = [];

  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }

  return chunks;
}

function upsertTickerFromPatch(symbol, patch, timestamp = Date.now()) {
  const existing = tickers.get(symbol);
  const ticker = normalizeBybitTicker({
    symbol,
    lastPrice: patch.lastPrice ?? existing?.price,
    turnover24h: patch.turnover24h ?? existing?.volume24h,
    volume24h: patch.volume24h,
    price24hPcnt: patch.price24hPcnt ?? existing?.price24hPcnt,
    fundingRate: patch.fundingRate ?? (
      Number.isFinite(Number(existing?.fundingRate)) ? Number(existing.fundingRate) / 100 : undefined
    ),
    openInterest: patch.openInterest ?? existing?.openInterest,
    openInterestValue: patch.openInterestValue ?? existing?.openInterestValue,
  });

  if (!ticker) {
    return null;
  }

  ticker.updatedAt = timestamp;
  tickers.set(ticker.symbol, ticker);
  recordPricePoint(ticker.symbol, ticker.price, timestamp);
  lastTickerFetchAt = timestamp;

  return ticker;
}

function loadStaticBybitSymbols() {
  // Loaded only as a fallback, so the live API remains the source of truth.
  // eslint-disable-next-line global-require
  const staticSymbols = require('../data/bybitSymbols');
  return new Set(staticSymbols);
}

async function loadBybitSymbols() {
  try {
    const apiSymbols = await exchange.getBybitSymbols();
    const symbols = apiSymbols instanceof Map
      ? new Set(apiSymbols.keys())
      : new Set(apiSymbols || []);

    if (symbols.size === 0) {
      throw new Error('Bybit API returned an empty symbol list');
    }

    bybitSymbols = symbols;
    logger.info(`Bybit symbols: loaded from API (${bybitSymbols.size})`);
    return bybitSymbols;
  } catch (error) {
    bybitSymbols = loadStaticBybitSymbols();
    logger.warn(`Bybit symbols: using static fallback (${bybitSymbols.size})`);
    logger.warn(`Bybit symbols API load failed: ${error.message}`);
    return bybitSymbols;
  }
}

function recordPricePoint(symbol, price, timestamp = Date.now()) {
  const history = priceHistory.get(symbol) || [];
  const cutoff = timestamp - PRICE_HISTORY_RETENTION_MS;

  history.push({ price, timestamp });
  priceHistory.set(symbol, history.filter((point) => point.timestamp > cutoff));
}

function getRealChange1h(symbol) {
  const normalizedSymbol = symbol.toUpperCase();
  const ticker = tickers.get(normalizedSymbol);
  const history = priceHistory.get(normalizedSymbol) || [];

  if (!ticker || history.length === 0) {
    return null;
  }

  const now = Date.now();
  const targetTimestamp = now - CHANGE_1H_TARGET_MS;
  let bestPoint = null;
  let bestDistance = Infinity;

  for (const point of history) {
    const age = now - point.timestamp;

    if (age < CHANGE_1H_MIN_AGE_MS || age > CHANGE_1H_MAX_AGE_MS) {
      continue;
    }

    const distance = Math.abs(point.timestamp - targetTimestamp);

    if (distance < bestDistance) {
      bestPoint = point;
      bestDistance = distance;
    }
  }

  if (!bestPoint || !Number.isFinite(bestPoint.price) || bestPoint.price <= 0) {
    return null;
  }

  return ((ticker.price - bestPoint.price) / bestPoint.price) * 100;
}

function isWarmingUp() {
  return Date.now() - startTime < WARMUP_MS;
}

function getWarmupRemainingMs() {
  return Math.max(0, WARMUP_MS - (Date.now() - startTime));
}

function getEmptyVolumeStats() {
  return {
    currentVolume: 0,
    maxVolume1h: 0,
    recentAverageVolume: 0,
    currentToAverageMultiplier: 0,
    recentVsPeakRatio: 0,
    isRecentVolumeFallingFromPeak: false,
    volumeTrend: 'нет данных',
  };
}

async function fetchBybitTickers() {
  if (isFetchingTickers) {
    logger.warn('Bybit ticker fetch already running, skipping this tick');
    return tickers;
  }

  isFetchingTickers = true;

  try {
    const response = await bybitClient.get('/v5/market/tickers', {
      params: {
        category: 'linear',
      },
    });
    const rows = Array.isArray(response.data?.result?.list) ? response.data.result.list : [];
    const fetchedAt = Date.now();
    let updated = 0;

    for (const row of rows) {
      const ticker = normalizeBybitTicker(row);

      if (ticker) {
        ticker.updatedAt = fetchedAt;
        tickers.set(ticker.symbol, ticker);
        recordPricePoint(ticker.symbol, ticker.price, fetchedAt);
        updated += 1;
      }
    }

    if (updated === 0) {
      throw new Error('Bybit ticker response did not contain linear USDT symbols');
    }

    lastTickerFetchAt = fetchedAt;
    logger.info(`Bybit tickers fetched: ${updated} symbols`);
    return tickers;
  } catch (error) {
    logger.error(`Bybit ticker fetch failed: ${error.stack || error.message}`);
    throw error;
  } finally {
    isFetchingTickers = false;
  }
}

async function fetchBybitTicker(symbol) {
  const normalizedSymbol = symbol?.toUpperCase();

  if (!normalizedSymbol) {
    return null;
  }

  try {
    const response = await bybitClient.get('/v5/market/tickers', {
      params: {
        category: 'linear',
        symbol: normalizedSymbol,
      },
    });
    const row = response.data?.result?.list?.[0];
    const ticker = row ? normalizeBybitTicker(row) : null;

    if (!ticker) {
      return null;
    }

    const fetchedAt = Date.now();
    ticker.updatedAt = fetchedAt;
    tickers.set(ticker.symbol, ticker);
    recordPricePoint(ticker.symbol, ticker.price, fetchedAt);

    return ticker;
  } catch (error) {
    logger.warn(`Bybit ticker fetch failed for ${normalizedSymbol}: ${error.message}`);
    return null;
  }
}

async function refreshTickersAndScan() {
  if (scanHandler) {
    await scanHandler();
  }
}

function closeTickerSockets() {
  for (const socket of wsConnections) {
    const pingTimer = wsPingTimers.get(socket);

    if (pingTimer) {
      clearInterval(pingTimer);
      wsPingTimers.delete(socket);
    }

    try {
      socket.removeAllListeners('close');
      socket.close();
    } catch (error) {
      logger.warn(`Bybit WS close failed: ${error.message}`);
    }
  }

  wsConnections.clear();
}

function scheduleWsReconnect() {
  if (!wsShouldReconnect || wsReconnectTimer) {
    return;
  }

  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    startBybitTickerWebSocket();
  }, BYBIT_WS_RECONNECT_DELAY_MS);
}

function handleTickerWsMessage(rawMessage) {
  let message;

  try {
    message = JSON.parse(rawMessage.toString());
  } catch (error) {
    logger.warn(`Bybit WS message parse failed: ${error.message}`);
    return;
  }

  if (message.op === 'pong' || message.success === true) {
    return;
  }

  const topic = message.topic;
  const payload = message.data;

  if (!topic?.startsWith('tickers.') || !payload) {
    return;
  }

  const symbol = topic.slice('tickers.'.length).toUpperCase();
  upsertTickerFromPatch(symbol, payload);
}

function startBybitTickerWebSocket() {
  const symbols = Array.from(bybitSymbols.size > 0 ? bybitSymbols : loadStaticBybitSymbols())
    .filter((symbol) => typeof symbol === 'string' && symbol.endsWith('USDT'));

  if (symbols.length === 0) {
    logger.warn('Bybit WS not started: no symbols available');
    return;
  }

  wsShouldReconnect = true;
  closeTickerSockets();

  const chunks = chunkArray(symbols, BYBIT_WS_BATCH_SIZE);

  for (const [index, symbolsChunk] of chunks.entries()) {
    const socket = new WebSocket(BYBIT_WS_URL);
    wsConnections.add(socket);

    socket.on('open', () => {
      const args = symbolsChunk.map((symbol) => `tickers.${symbol}`);
      socket.send(JSON.stringify({ op: 'subscribe', args }));
      logger.info(`Bybit WS ticker batch ${index + 1}/${chunks.length} subscribed: ${symbolsChunk.length} symbols`);

      const pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ op: 'ping' }));
        }
      }, BYBIT_WS_PING_INTERVAL_MS);
      wsPingTimers.set(socket, pingTimer);
    });

    socket.on('message', handleTickerWsMessage);

    socket.on('error', (error) => {
      logger.warn(`Bybit WS ticker batch ${index + 1} error: ${error.message}`);
    });

    socket.on('close', () => {
      const pingTimer = wsPingTimers.get(socket);

      if (pingTimer) {
        clearInterval(pingTimer);
        wsPingTimers.delete(socket);
      }

      wsConnections.delete(socket);
      logger.warn(`Bybit WS ticker batch ${index + 1} closed`);
      scheduleWsReconnect();
    });
  }

  logger.info(`Bybit WS ticker scanner started: ${symbols.length} symbols, ${chunks.length} connections`);
}

function startTickerStream(onScan) {
  scanHandler = onScan;

  loadBybitSymbols().then(() => {
    startBybitTickerWebSocket();
  }).catch((error) => {
    logger.warn(`Initial Bybit symbols load failed: ${error.message}`);
    bybitSymbols = loadStaticBybitSymbols();
    startBybitTickerWebSocket();
  });

  if (!symbolRefreshTimer) {
    symbolRefreshTimer = setInterval(() => {
      loadBybitSymbols().then(() => {
        startBybitTickerWebSocket();
      }).catch((error) => {
        logger.warn(`Scheduled Bybit symbols refresh failed: ${error.message}`);
      });
    }, SYMBOL_REFRESH_INTERVAL_MS);
  }

  if (!scanTimer) {
    scanTimer = setInterval(() => {
      Promise.resolve(refreshTickersAndScan()).catch((error) => {
        logger.error(`Bybit ticker scanner interval failed: ${error.message}`);
      });
    }, config.SCAN_INTERVAL_MINUTES * 60 * 1000);
    logger.info(`Bybit WS scanner interval started: every ${config.SCAN_INTERVAL_MINUTES} minutes`);
  }
}

function stopTickerStream() {
  wsShouldReconnect = false;

  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }

  closeTickerSockets();

  if (symbolRefreshTimer) {
    clearInterval(symbolRefreshTimer);
    symbolRefreshTimer = null;
  }

  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }

  logger.info('Bybit WS scanner stopped');
}

function getCachedTicker(symbol) {
  if (!symbol) {
    return null;
  }

  const ticker = tickers.get(symbol.toUpperCase());

  return ticker ? { ...ticker } : null;
}

function getCachedPrice(symbol) {
  const ticker = getCachedTicker(symbol);
  return ticker ? ticker.price : null;
}

function getCacheSize() {
  return tickers.size;
}

function isConnected() {
  return Date.now() - lastTickerFetchAt <= config.SCAN_INTERVAL_MINUTES * 90_000;
}

function isKnownBybitSymbol(symbol) {
  return Boolean(symbol && bybitSymbols.has(symbol.toUpperCase()));
}

function getBybitSymbolCount() {
  return bybitSymbols.size;
}

function getSignalType(coinData) {
  const change1h = Number(coinData.change1h);
  const fundingRate = Number(coinData.fundingRate || 0);

  if (!Number.isFinite(change1h) || !Number.isFinite(Number(coinData.volume24h))) {
    return null;
  }

  if (!isKnownBybitSymbol(coinData.symbol)) {
    return null;
  }

  if (change1h >= 20) {
    return 'SHORT';
  }

  if (change1h >= config.SHORT_MIN_PUMP && fundingRate > config.SHORT_FUNDING_THRESHOLD) {
    return 'SHORT';
  }

  if (change1h >= config.LONG_MIN_PUMP && change1h < config.LONG_MAX_PUMP) {
    return 'LONG';
  }

  if (change1h >= config.SHORT_MIN_PUMP) {
    return 'SHORT';
  }

  return null;
}

async function getFullCoinDataWS(symbol) {
  if (!symbol) {
    throw new Error('Symbol is required for getFullCoinDataWS');
  }

  const normalizedSymbol = symbol.toUpperCase();
  const ticker = getCachedTicker(normalizedSymbol) || await fetchBybitTicker(normalizedSymbol);
  const volumeStats = getEmptyVolumeStats();

  if (!ticker) {
    logger.warn(`No Bybit ticker data available for ${normalizedSymbol}`);
    return {
      symbol: normalizedSymbol,
      price: 0,
      change1h: 0,
      change24h: 0,
      volume24h: 0,
      openInterest: 0,
      openInterestValue: 0,
      oiChange: 0,
      oiTrend: 'нет данных',
      fundingRate: 0,
      klines: [],
      candles: [],
      volumeStats,
      volumeTrend: volumeStats.volumeTrend,
    };
  }

  const change1h = getRealChange1h(normalizedSymbol) ?? 0;

  return {
    symbol: normalizedSymbol,
    price: ticker.price,
    change1h,
    change24h: ticker.change24h,
    volume24h: ticker.volume24h,
    openInterest: ticker.openInterest || 0,
    openInterestValue: ticker.openInterestValue || 0,
    oiChange: 0,
    oiTrend: 'нет данных',
    fundingRate: Number.isFinite(Number(ticker.fundingRate)) ? Number(ticker.fundingRate) : 0,
    klines: [],
    candles: [],
    volumeStats,
    volumeTrend: volumeStats.volumeTrend,
  };
}

async function scanMarket() {
  logger.info(`Starting market scan from Bybit ticker cache, tickers=${tickers.size}`);

  if (isWarmingUp()) {
    const minutesLeft = Math.ceil(getWarmupRemainingMs() / 60_000);
    logger.info(`Scanner warming up, ${minutesLeft} minutes until signals are enabled`);
    return [];
  }

  const candidates = Array.from(tickers.values())
    .map((coin) => ({
      ...coin,
      change1h: getRealChange1h(coin.symbol),
    }))
    .filter((coin) => Number.isFinite(coin.volume24h))
    .filter((coin) => isKnownBybitSymbol(coin.symbol))
    .filter((coin) => coin.change1h !== null && coin.change1h >= config.LONG_MIN_PUMP)
    .filter((coin) => canSendSignal(coin.symbol))
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, config.TOP_COINS_COUNT);

  logger.info(`Pre-filtered ${candidates.length} candidates from Bybit cache with 1h change >= ${config.LONG_MIN_PUMP}%`);

  const signalCandidates = [];

  for (const coin of candidates) {
    try {
      const coinData = await getFullCoinDataWS(coin.symbol);
      const signalType = getSignalType(coinData);

      if (signalType === 'SHORT') {
        signalCandidates.push({
          ...coinData,
          signalType: 'SHORT',
        });
        continue;
      }

      if (signalType === 'LONG') {
        signalCandidates.push({
          ...coinData,
          signalType: 'LONG',
        });
      }
    } catch (error) {
      logger.warn(`Skipping ${coin.symbol}: ${error.message}`);
    }
  }

  logger.info(`Market scan finished, found ${signalCandidates.length} signal candidates`);

  return signalCandidates;
}

module.exports = {
  startTickerStream,
  stopTickerStream,
  scanMarket,
  canSendSignal,
  markSignalSent,
  loadBybitSymbols,
  fetchBybitTickers,
  fetchBybitTicker,
  startBybitTickerWebSocket,
  getCachedTicker,
  getCachedPrice,
  getCacheSize,
  isConnected,
  isKnownBybitSymbol,
  getBybitSymbolCount,
  isWarmingUp,
  getWarmupRemainingMs,
  getRealChange1h,
  getSignalType,
  getFullCoinDataWS,
};
