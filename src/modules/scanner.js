const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const BYBIT_BASE_URL = 'https://api.bybit.com';
const PRICE_HISTORY_RETENTION_MS = 70 * 60 * 1000;
const CHANGE_1H_TARGET_MS = 60 * 60 * 1000;
const CHANGE_1H_MIN_AGE_MS = 55 * 60 * 1000;
const CHANGE_1H_MAX_AGE_MS = 65 * 60 * 1000;
const WARMUP_MS = 65 * 60 * 1000;
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
let scanHandler = null;
let isFetchingTickers = false;
let lastTickerFetchAt = 0;

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

async function refreshTickersAndScan() {
  try {
    await fetchBybitTickers();
  } catch (error) {
    logger.warn(`Using previous Bybit ticker cache after fetch failure: ${error.message}`);
  }

  if (scanHandler) {
    await scanHandler();
  }
}

function startTickerStream(onScan) {
  scanHandler = onScan;

  fetchBybitTickers().catch((error) => {
    logger.warn(`Initial Bybit ticker fetch failed: ${error.message}`);
  });

  if (!scanTimer) {
    scanTimer = setInterval(() => {
      Promise.resolve(refreshTickersAndScan()).catch((error) => {
        logger.error(`Bybit ticker scanner interval failed: ${error.message}`);
      });
    }, config.SCAN_INTERVAL_MINUTES * 60 * 1000);
    logger.info(`Bybit REST scanner interval started: every ${config.SCAN_INTERVAL_MINUTES} minutes`);
  }
}

function stopTickerStream() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }

  logger.info('Bybit REST scanner stopped');
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
  return Boolean(symbol && tickers.has(symbol.toUpperCase()));
}

function getBybitSymbolCount() {
  return tickers.size;
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
  const ticker = getCachedTicker(normalizedSymbol);

  if (!ticker) {
    throw new Error(`Ticker cache is empty for ${normalizedSymbol}`);
  }

  const change1h = getRealChange1h(normalizedSymbol);

  if (change1h === null) {
    throw new Error(`Not enough 1h price history for ${normalizedSymbol}`);
  }

  const volumeStats = getEmptyVolumeStats();

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
    .filter((coin) => Number.isFinite(coin.volume24h) && coin.volume24h >= config.MIN_VOLUME_24H)
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
  fetchBybitTickers,
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
