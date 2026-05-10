const WebSocket = require('ws');
const config = require('../config');
const logger = require('../utils/logger');

const BINANCE_MINI_TICKER_WS_URLS = [
  'wss://fstream.binance.com/ws/!miniTicker@arr',
  'wss://fstream.binancefuture.com/ws/!miniTicker@arr',
];
const BINANCE_SYMBOL_WS_BASE_URL = 'wss://fstream.binancefuture.com/ws';
const PRICE_HISTORY_WINDOW_MS = 60 * 60 * 1000;
const lastSignalSentAt = new Map();
const tickers = new Map();
const priceHistory = new Map();

let ws = null;
let reconnectTimer = null;
let scanTimer = null;
let firstMessageTimer = null;
let wsEndpointIndex = 0;
let reconnectAttempts = 0;
let scanHandler = null;
let oiStreamUnavailable = false;

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

function normalizeMiniTicker(ticker) {
  const symbol = ticker.s;
  const price = Number(ticker.c);
  const baseVolume = Number(ticker.v);
  const quoteVolume = Number(ticker.q);
  const openPrice = Number(ticker.o);
  const streamChange1h = Number(ticker.P);
  const streamChange24h = Number(ticker.p);

  if (!symbol || !symbol.endsWith('USDT') || !Number.isFinite(price) || price <= 0) {
    return null;
  }

  const change24h = Number.isFinite(streamChange24h)
    ? streamChange24h
    : Number.isFinite(openPrice) && openPrice > 0
      ? ((price - openPrice) / openPrice) * 100
      : 0;
  const volume24h = Number.isFinite(quoteVolume) && quoteVolume > 0
    ? quoteVolume
    : Number.isFinite(baseVolume)
      ? baseVolume * price
      : 0;

  return {
    symbol,
    price,
    change1h: Number.isFinite(streamChange1h) ? streamChange1h : null,
    change24h,
    volume24h,
    updatedAt: Date.now(),
  };
}

function recordPricePoint(ticker) {
  const now = Date.now();
  const history = priceHistory.get(ticker.symbol) || [];

  history.push({
    price: ticker.price,
    timestamp: now,
  });

  while (history.length > 0 && now - history[0].timestamp > PRICE_HISTORY_WINDOW_MS) {
    history.shift();
  }

  priceHistory.set(ticker.symbol, history);
}

function calculateCachedChange1h(symbol, currentPrice) {
  const history = priceHistory.get(symbol.toUpperCase()) || [];

  if (history.length === 0) {
    return 0;
  }

  const first = history[0];
  const lastPrice = Number.isFinite(currentPrice) ? currentPrice : history[history.length - 1].price;

  if (!first.price || !Number.isFinite(first.price) || first.price <= 0 || !Number.isFinite(lastPrice)) {
    return 0;
  }

  return ((lastPrice - first.price) / first.price) * 100;
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

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectAttempts += 1;
  const delay = Math.min(30_000, 1_000 * reconnectAttempts);

  logger.warn(`Binance ticker WebSocket reconnect scheduled in ${delay}ms`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectTickerStream();
  }, delay);
}

function clearFirstMessageTimer() {
  if (firstMessageTimer) {
    clearTimeout(firstMessageTimer);
    firstMessageTimer = null;
  }
}

function scheduleEndpointFallback(url) {
  clearFirstMessageTimer();

  firstMessageTimer = setTimeout(() => {
    logger.warn(`No Binance miniTicker data received from ${url}; switching WebSocket endpoint`);
    wsEndpointIndex = (wsEndpointIndex + 1) % BINANCE_MINI_TICKER_WS_URLS.length;

    if (ws) {
      ws.terminate();
    }
  }, 10_000);
}

function connectTickerStream() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const url = BINANCE_MINI_TICKER_WS_URLS[wsEndpointIndex];

  logger.info(`Connecting Binance miniTicker WebSocket: ${url}`);
  ws = new WebSocket(url);

  ws.on('open', () => {
    reconnectAttempts = 0;
    logger.info(`Binance miniTicker WebSocket connected: ${url}`);
    scheduleEndpointFallback(url);
  });

  ws.on('message', (rawMessage) => {
    try {
      const payload = JSON.parse(rawMessage.toString());
      const payloadData = payload && payload.data ? payload.data : payload;
      const items = Array.isArray(payloadData) ? payloadData : [payloadData];

      for (const item of items) {
        const ticker = normalizeMiniTicker(item);

        if (ticker) {
          if (!Number.isFinite(ticker.change1h)) {
            ticker.change1h = calculateCachedChange1h(ticker.symbol, ticker.price);
          }

          tickers.set(ticker.symbol, ticker);
          recordPricePoint(ticker);
        }
      }

      if (tickers.size > 0) {
        clearFirstMessageTimer();
      }
    } catch (error) {
      logger.warn(`Failed to parse Binance miniTicker message: ${error.message}`);
    }
  });

  ws.on('close', (code, reason) => {
    clearFirstMessageTimer();
    logger.warn(`Binance miniTicker WebSocket closed: code=${code}, reason=${reason.toString()}`);
    ws = null;
    scheduleReconnect();
  });

  ws.on('error', (error) => {
    logger.error(`Binance miniTicker WebSocket error: ${error.message}`);
  });
}

function startTickerStream(onScan) {
  scanHandler = onScan;
  connectTickerStream();

  if (!scanTimer) {
    scanTimer = setInterval(() => {
      if (scanHandler) {
        Promise.resolve(scanHandler()).catch((error) => {
          logger.error(`WebSocket scanner interval failed: ${error.message}`);
        });
      }
    }, config.SCAN_INTERVAL_MINUTES * 60 * 1000);
    logger.info(`WebSocket scanner interval started: every ${config.SCAN_INTERVAL_MINUTES} minutes`);
  }
}

function stopTickerStream() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  clearFirstMessageTimer();

  if (ws) {
    ws.removeAllListeners();
    ws.close();
    ws = null;
  }

  logger.info('Binance miniTicker WebSocket stopped');
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
  return Boolean(ws && ws.readyState === WebSocket.OPEN);
}

function getSignalType(coinData) {
  const change1h = Number(coinData.change1h);
  const fundingRate = Number(coinData.fundingRate || 0);

  if (!Number.isFinite(change1h) || !Number.isFinite(Number(coinData.volume24h))) {
    return null;
  }

  if (coinData.volume24h < config.MIN_VOLUME_24H) {
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

function readOneWebSocketMessage(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;

    const finish = (error, data) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();

      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }

      if (error) {
        reject(error);
      } else {
        resolve(data);
      }
    };

    const timer = setTimeout(() => {
      finish(new Error(`WebSocket timeout for ${url}`));
    }, timeoutMs);

    socket.on('message', (rawMessage) => {
      try {
        finish(null, JSON.parse(rawMessage.toString()));
      } catch (error) {
        finish(error);
      }
    });

    socket.on('error', finish);
    socket.on('close', () => {
      finish(new Error(`WebSocket closed before message for ${url}`));
    });
  });
}

async function subscribeOI(symbol) {
  const normalizedSymbol = symbol.toUpperCase();

  if (oiStreamUnavailable) {
    return {
      openInterest: 0,
      oiChange: 0,
      oiTrend: 'нет данных',
    };
  }

  const url = `${BINANCE_SYMBOL_WS_BASE_URL}/${normalizedSymbol.toLowerCase()}@openInterest`;

  try {
    const data = await readOneWebSocketMessage(url, 1_500);
    const openInterest = Number(data.openInterest ?? data.o ?? data.oi ?? data.OI ?? 0);

    return {
      openInterest: Number.isFinite(openInterest) ? openInterest : 0,
      oiChange: 0,
      oiTrend: 'нет данных',
    };
  } catch (error) {
    oiStreamUnavailable = true;
    logger.warn(`OI WebSocket unavailable for ${normalizedSymbol}: ${error.message}`);
    return {
      openInterest: 0,
      oiChange: 0,
      oiTrend: 'нет данных',
    };
  }
}

async function subscribeFunding(symbol) {
  const normalizedSymbol = symbol.toUpperCase();
  const url = `${BINANCE_SYMBOL_WS_BASE_URL}/${normalizedSymbol.toLowerCase()}@markPrice`;

  try {
    const data = await readOneWebSocketMessage(url, 5_000);
    const fundingRate = Number(data.r);

    return Number.isFinite(fundingRate) ? fundingRate * 100 : 0;
  } catch (error) {
    logger.warn(`Funding WebSocket unavailable for ${normalizedSymbol}: ${error.message}`);
    return 0;
  }
}

async function getFullCoinDataWS(symbol) {
  if (!symbol) {
    throw new Error('Symbol is required for getFullCoinDataWS');
  }

  const normalizedSymbol = symbol.toUpperCase();
  const ticker = getCachedTicker(normalizedSymbol);

  if (!ticker) {
    throw new Error(`Ticker cache is empty for ${normalizedSymbol}`);
  }

  const [openInterestData, fundingRate] = await Promise.all([
    subscribeOI(normalizedSymbol),
    subscribeFunding(normalizedSymbol),
  ]);
  const volumeStats = getEmptyVolumeStats();

  return {
    symbol: normalizedSymbol,
    price: ticker.price,
    change1h: ticker.change1h,
    change24h: ticker.change24h,
    volume24h: ticker.volume24h,
    openInterest: openInterestData.openInterest || 0,
    oiChange: openInterestData.oiChange || 0,
    oiTrend: openInterestData.oiTrend || 'нет данных',
    fundingRate: Number.isFinite(Number(fundingRate)) ? Number(fundingRate) : 0,
    klines: [],
    candles: [],
    volumeStats,
    volumeTrend: volumeStats.volumeTrend,
  };
}

async function scanMarket() {
  logger.info(`Starting market scan from WebSocket cache, tickers=${tickers.size}`);

  const candidates = Array.from(tickers.values())
    .filter((coin) => Number.isFinite(coin.volume24h) && coin.volume24h >= config.MIN_VOLUME_24H)
    .filter((coin) => Number.isFinite(coin.change1h) && coin.change1h >= config.LONG_MIN_PUMP)
    .filter((coin) => canSendSignal(coin.symbol))
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, config.TOP_COINS_COUNT);

  logger.info(`Pre-filtered ${candidates.length} candidates from WebSocket cache with 1h change >= ${config.LONG_MIN_PUMP}%`);

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
  getCachedTicker,
  getCachedPrice,
  getCacheSize,
  isConnected,
  getSignalType,
  subscribeOI,
  subscribeFunding,
  getFullCoinDataWS,
};
