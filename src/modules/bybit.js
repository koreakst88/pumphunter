const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const client = axios.create({
  baseURL: config.BYBIT_BASE_URL,
  timeout: 10_000,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, params = {}) {
  await sleep(config.RATE_LIMIT_DELAY_MS);

  try {
    const response = await client.get(path, { params });
    const data = response.data;

    if (data.retCode !== 0) {
      throw new Error(`Bybit retCode=${data.retCode}: ${data.retMsg || 'Unknown API error'}`);
    }

    return data.result;
  } catch (error) {
    const status = error.response?.status;
    const message = error.response?.data?.retMsg || error.message;

    if (status === 429 || /rate limit/i.test(message)) {
      logger.warn(`Bybit rate limit hit for ${path}: ${message}`);
    } else {
      logger.error(`Bybit request failed for ${path}: ${message}`);
    }

    throw error;
  }
}

function normalizeTicker(ticker) {
  const lastPrice = Number(ticker.lastPrice);
  const prevPrice24h = Number(ticker.prevPrice24h);
  const price24hPcnt = Number(ticker.price24hPcnt);
  const priceChange24h = Number.isFinite(lastPrice) && Number.isFinite(prevPrice24h) && prevPrice24h > 0
    ? ((lastPrice - prevPrice24h) / prevPrice24h) * 100
    : price24hPcnt * 100;

  return {
    symbol: ticker.symbol,
    lastPrice,
    price: lastPrice,
    prevPrice24h,
    volume24h: Number(ticker.turnover24h),
    baseVolume24h: Number(ticker.volume24h),
    price24hPcnt,
    priceChange24h,
  };
}

function normalizeKline(kline) {
  const [startTime, open, high, low, close, volume, turnover] = kline;

  return {
    startTime: Number(startTime),
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
    turnover: Number(turnover),
  };
}

function normalizeOpenInterest(item) {
  return {
    timestamp: Number(item.timestamp),
    openInterest: Number(item.openInterest),
  };
}

function calculateOiTrend(oiChange) {
  if (oiChange > 1) {
    return 'растёт';
  }

  if (oiChange < -1) {
    return 'падает';
  }

  return 'стабильно';
}

function calculateVolumeStats(klines) {
  const volumes = klines.map((kline) => kline.volume).filter(Number.isFinite);
  if (volumes.length === 0) {
    return getEmptyVolumeStats();
  }

  const recentVolumes = volumes.slice(-3);
  const previousVolumes = volumes.slice(0, -1);
  const maxVolume1h = Math.max(...volumes);
  const averageVolume = previousVolumes.length > 0
    ? previousVolumes.reduce((sum, volume) => sum + volume, 0) / previousVolumes.length
    : 0;
  const currentVolume = volumes[volumes.length - 1] || 0;
  const recentAverageVolume = recentVolumes.length > 0
    ? recentVolumes.reduce((sum, volume) => sum + volume, 0) / recentVolumes.length
    : 0;

  return {
    currentVolume,
    maxVolume1h,
    recentAverageVolume,
    currentToAverageMultiplier: averageVolume > 0 ? currentVolume / averageVolume : 0,
    recentVsPeakRatio: maxVolume1h > 0 ? recentAverageVolume / maxVolume1h : 0,
    isRecentVolumeFallingFromPeak: maxVolume1h > 0 && recentAverageVolume <= maxVolume1h * 0.7,
  };
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

function calculatePriceChangeFromKlines(symbol, klines) {
  if (!Array.isArray(klines) || klines.length < 2) {
    logger.warn(`Not enough kline data for ${symbol}: received ${klines?.length || 0}`);
    return 0;
  }

  const firstOpen = klines[0].open;
  const lastClose = klines[klines.length - 1].close;

  if (!Number.isFinite(firstOpen) || firstOpen <= 0 || !Number.isFinite(lastClose)) {
    logger.warn(`Invalid kline prices for ${symbol}`);
    return 0;
  }

  return ((lastClose - firstOpen) / firstOpen) * 100;
}

async function safeRequest(label, fallback, handler) {
  try {
    const result = await handler();
    return result ?? fallback;
  } catch (error) {
    logger.warn(`${label} failed: ${error.stack || error.message}`);
    return fallback;
  }
}

async function getTopCoins() {
  logger.info('Fetching Bybit linear tickers');

  const result = await request('/v5/market/tickers', { category: 'linear' });
  const tickers = result.list || [];

  const coins = tickers
    .map(normalizeTicker)
    .filter((coin) => coin.symbol.endsWith('USDT'))
    .filter((coin) => !config.EXCLUDED_PAIRS.includes(coin.symbol))
    .filter((coin) => Number.isFinite(coin.volume24h) && coin.volume24h >= config.MIN_VOLUME_24H)
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, config.TOP_COINS_COUNT);

  logger.info(`Fetched ${coins.length} top coins with 24h volume >= $${config.MIN_VOLUME_24H}`);

  return coins;
}

async function getTicker(symbol) {
  logger.info(`Fetching ticker for ${symbol}`);

  const result = await request('/v5/market/tickers', {
    category: 'linear',
    symbol,
  });

  const ticker = result.list?.[0];

  if (!ticker) {
    throw new Error(`Ticker not found for ${symbol}`);
  }

  return normalizeTicker(ticker);
}

async function getKlines(symbol, interval = '5', limit = 12) {
  logger.info(`Fetching klines for ${symbol}, interval=${interval}, limit=${limit}`);

  const result = await request('/v5/market/kline', {
    category: 'linear',
    symbol,
    interval,
    limit,
  });

  return (result.list || [])
    .map(normalizeKline)
    .sort((a, b) => a.startTime - b.startTime);
}

async function getPriceChange1h(symbol) {
  const klines = await getKlines(symbol, '5', 12);

  if (klines.length < 2) {
    throw new Error(`Not enough kline data for ${symbol}: received ${klines.length}`);
  }

  const firstOpen = klines[0].open;
  const lastClose = klines[klines.length - 1].close;

  if (!Number.isFinite(firstOpen) || firstOpen <= 0 || !Number.isFinite(lastClose)) {
    throw new Error(`Invalid kline prices for ${symbol}`);
  }

  const changePercent = ((lastClose - firstOpen) / firstOpen) * 100;

  logger.info(`1h price change for ${symbol}: ${changePercent.toFixed(2)}%`);

  return changePercent;
}

async function getOpenInterest(symbol) {
  logger.info(`Fetching open interest for ${symbol}`);

  const result = await request('/v5/market/open-interest', {
    category: 'linear',
    symbol,
    intervalTime: '5min',
    limit: 12,
  });

  const history = (result.list || [])
    .map(normalizeOpenInterest)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (history.length < 2) {
    throw new Error(`Not enough open interest data for ${symbol}: received ${history.length}`);
  }

  const firstOpenInterest = history[0].openInterest;
  const currentOpenInterest = history[history.length - 1].openInterest;

  if (!Number.isFinite(firstOpenInterest) || firstOpenInterest <= 0 || !Number.isFinite(currentOpenInterest)) {
    throw new Error(`Invalid open interest data for ${symbol}`);
  }

  const oiChange = ((currentOpenInterest - firstOpenInterest) / firstOpenInterest) * 100;
  const oiTrend = calculateOiTrend(oiChange);

  return {
    history,
    current: currentOpenInterest,
    changePercent: oiChange,
    trend: oiTrend,
  };
}

async function getFundingRate(symbol) {
  logger.info(`Fetching funding rate for ${symbol}`);

  const result = await request('/v5/market/tickers', {
    category: 'linear',
    symbol,
  });
  const rawFundingRate = Number(result.list?.[0]?.fundingRate);

  if (!Number.isFinite(rawFundingRate)) {
    throw new Error(`Invalid funding rate for ${symbol}`);
  }

  return rawFundingRate * 100;
}

async function getFullCoinData(symbol, tickerData = null) {
  if (!symbol) {
    throw new Error('Symbol is required for getFullCoinData');
  }

  const normalizedSymbol = symbol.toUpperCase();
  const fallbackTicker = {
    symbol: normalizedSymbol,
    price: 0,
    volume24h: 0,
  };
  const fallbackOpenInterest = {
    history: [],
    current: 0,
    changePercent: 0,
    trend: 'нет данных',
  };

  const [ticker, klines, openInterest, fundingRate] = await Promise.all([
    tickerData ? Promise.resolve(tickerData) : safeRequest(`Ticker for ${normalizedSymbol}`, fallbackTicker, () => getTicker(normalizedSymbol)),
    safeRequest(`Klines for ${normalizedSymbol}`, [], () => getKlines(normalizedSymbol, '5', 12)),
    safeRequest(`Open interest for ${normalizedSymbol}`, fallbackOpenInterest, () => getOpenInterest(normalizedSymbol)),
    safeRequest(`Funding rate for ${normalizedSymbol}`, 0, () => getFundingRate(normalizedSymbol)),
  ]);
  const safeTicker = ticker || fallbackTicker;
  const safeKlines = Array.isArray(klines) ? klines : [];
  const safeFundingRate = Number.isFinite(Number(fundingRate)) ? Number(fundingRate) : 0;
  const volumeStats = safeKlines.length > 0 ? calculateVolumeStats(safeKlines) : getEmptyVolumeStats();
  const change1h = calculatePriceChangeFromKlines(normalizedSymbol, safeKlines);

  return {
    symbol: normalizedSymbol,
    price: safeTicker.price,
    change1h,
    volume24h: safeTicker.volume24h,
    openInterest: openInterest.current,
    oiChange: openInterest.changePercent,
    oiTrend: openInterest.trend,
    fundingRate: safeFundingRate,
    klines: safeKlines,
    volumeStats,
    volumeTrend: volumeStats.volumeTrend || undefined,
  };
}

module.exports = {
  getTopCoins,
  getTicker,
  getKlines,
  getPriceChange1h,
  getOpenInterest,
  getFundingRate,
  getFullCoinData,
};
