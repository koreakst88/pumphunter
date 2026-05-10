const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const client = axios.create({
  baseURL: config.BINANCE_BASE_URL,
  timeout: 10_000,
});
const bybitClient = axios.create({
  baseURL: 'https://api.bybit.com',
  timeout: 10_000,
  headers: {
    'User-Agent': 'Mozilla/5.0',
    Accept: 'application/json',
  },
});
const BYBIT_SYMBOL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let bybitSymbolCache = null;
let bybitSymbolCacheUpdatedAt = 0;

function buildProxyUrl(path, params = {}) {
  const queryString = new URLSearchParams(params).toString();
  return `${config.CLOUDFLARE_PROXY_URL}?path=${path}&params=${encodeURIComponent(queryString)}`;
}

async function request(path, params = {}) {
  await sleep(config.RATE_LIMIT_DELAY_MS);

  try {
    const response = config.CLOUDFLARE_PROXY_URL
      ? await axios.get(buildProxyUrl(path, params), { timeout: 10_000 })
      : await client.get(path, { params });
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const data = error.response?.data ? JSON.stringify(error.response.data) : '';
    const transport = config.CLOUDFLARE_PROXY_URL ? 'Cloudflare proxy' : 'Binance direct';
    logger.error(`${transport} request failed for ${path}: status=${status || 'n/a'} ${error.message} ${data}`);
    throw error;
  }
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

function normalizeTicker(ticker) {
  return {
    symbol: ticker.symbol,
    price: Number(ticker.lastPrice),
    lastPrice: Number(ticker.lastPrice),
    volume24h: Number(ticker.quoteVolume),
    baseVolume24h: Number(ticker.volume),
    priceChange24h: Number(ticker.priceChangePercent),
  };
}

function normalizeKline(kline) {
  const [
    openTime,
    open,
    high,
    low,
    close,
    volume,
    closeTime,
    quoteVolume,
  ] = kline;

  return {
    timestamp: Number(openTime),
    startTime: Number(openTime),
    closeTime: Number(closeTime),
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
    turnover: Number(quoteVolume),
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

function calculatePriceChangeFromKlines(symbol, klines) {
  if (!Array.isArray(klines) || klines.length < 2) {
    logger.warn(`Not enough kline data for ${symbol}: received ${klines?.length || 0}`);
    return {
      change1h: 0,
      currentPrice: klines?.[klines.length - 1]?.close || 0,
    };
  }

  const firstOpen = klines[0].open;
  const lastClose = klines[klines.length - 1].close;

  if (!Number.isFinite(firstOpen) || firstOpen <= 0 || !Number.isFinite(lastClose)) {
    logger.warn(`Invalid kline prices for ${symbol}`);
    return {
      change1h: 0,
      currentPrice: 0,
    };
  }

  return {
    change1h: ((lastClose - firstOpen) / firstOpen) * 100,
    currentPrice: lastClose,
  };
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

async function getBybitSymbols() {
  const now = Date.now();

  if (bybitSymbolCache && now - bybitSymbolCacheUpdatedAt < BYBIT_SYMBOL_CACHE_TTL_MS) {
    return new Set(bybitSymbolCache);
  }

  try {
    logger.info('Fetching Bybit linear symbols');
    const response = await bybitClient.get('/v5/market/tickers', {
      params: {
        category: 'linear',
      },
    });
    const rows = Array.isArray(response.data?.result?.list) ? response.data.result.list : [];
    const symbols = new Set(
      rows
        .map((ticker) => ticker.symbol)
        .filter((symbol) => typeof symbol === 'string' && symbol.endsWith('USDT'))
    );

    if (symbols.size === 0) {
      throw new Error('Bybit symbol list is empty');
    }

    bybitSymbolCache = symbols;
    bybitSymbolCacheUpdatedAt = now;
    logger.info(`Fetched ${symbols.size} Bybit linear symbols`);

    return new Set(bybitSymbolCache);
  } catch (error) {
    logger.error(`Bybit symbols fetch failed: ${error.stack || error.message}`);

    if (bybitSymbolCache) {
      return new Set(bybitSymbolCache);
    }

    throw error;
  }
}

async function getTopCoins() {
  logger.info('Fetching Binance futures 24h tickers');

  const tickers = await request('/fapi/v1/ticker/24hr');

  const coins = (Array.isArray(tickers) ? tickers : [])
    .map(normalizeTicker)
    .filter((coin) => coin.symbol.endsWith('USDT'))
    .filter((coin) => !config.EXCLUDED_PAIRS.includes(coin.symbol))
    .filter((coin) => Number.isFinite(coin.volume24h) && coin.volume24h >= config.MIN_VOLUME_24H)
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, config.TOP_COINS_COUNT);

  logger.info(`Fetched ${coins.length} Binance futures coins with 24h volume >= $${config.MIN_VOLUME_24H}`);

  return coins;
}

async function getTicker(symbol) {
  logger.info(`Fetching Binance ticker for ${symbol}`);

  const ticker = await request('/fapi/v1/ticker/24hr', { symbol });

  if (!ticker?.symbol) {
    throw new Error(`Ticker not found for ${symbol}`);
  }

  return normalizeTicker(ticker);
}

async function getKlines(symbol, interval = '5m', limit = 12) {
  logger.info(`Fetching Binance klines for ${symbol}, interval=${interval}, limit=${limit}`);

  const klines = await request('/fapi/v1/klines', {
    symbol,
    interval,
    limit,
  });

  return (Array.isArray(klines) ? klines : [])
    .map(normalizeKline)
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function getPriceChange1h(symbol) {
  const candles = await getKlines(symbol, '5m', 12);
  const { change1h, currentPrice } = calculatePriceChangeFromKlines(symbol, candles);

  logger.info(`1h price change for ${symbol}: ${change1h.toFixed(2)}%`);

  return {
    change1h,
    currentPrice,
    candles,
  };
}

async function getOpenInterest(symbol) {
  logger.info(`Fetching Binance open interest for ${symbol}`);

  const [current, history] = await Promise.all([
    request('/fapi/v1/openInterest', { symbol }),
    request('/futures/data/openInterestHist', {
      symbol,
      period: '5m',
      limit: 12,
    }),
  ]);
  const openInterest = Number(current?.openInterest || 0);
  const rows = Array.isArray(history) ? history : [];

  if (rows.length < 2) {
    return {
      openInterest,
      oiChange: 0,
      oiTrend: 'нет данных',
    };
  }

  const firstOpenInterest = Number(rows[0].sumOpenInterest);
  const lastOpenInterest = Number(rows[rows.length - 1].sumOpenInterest);

  if (!Number.isFinite(firstOpenInterest) || firstOpenInterest <= 0 || !Number.isFinite(lastOpenInterest)) {
    return {
      openInterest,
      oiChange: 0,
      oiTrend: 'нет данных',
    };
  }

  const oiChange = ((lastOpenInterest - firstOpenInterest) / firstOpenInterest) * 100;

  return {
    openInterest,
    oiChange,
    oiTrend: calculateOiTrend(oiChange),
  };
}

async function getFundingRate(symbol) {
  logger.info(`Fetching Binance funding rate for ${symbol}`);

  const premiumIndex = await request('/fapi/v1/premiumIndex', { symbol });
  const rawFundingRate = Number(premiumIndex?.lastFundingRate);

  if (!Number.isFinite(rawFundingRate)) {
    return 0;
  }

  return rawFundingRate * 100;
}

async function getFullCoinData(symbol) {
  if (!symbol) {
    throw new Error('Symbol is required for getFullCoinData');
  }

  const normalizedSymbol = symbol.toUpperCase();
  const [priceData, openInterestData, fundingRate, ticker] = await Promise.all([
    safeRequest(
      `Price data for ${normalizedSymbol}`,
      { change1h: 0, currentPrice: 0, candles: [] },
      () => getPriceChange1h(normalizedSymbol)
    ),
    safeRequest(
      `Open interest for ${normalizedSymbol}`,
      { openInterest: 0, oiChange: 0, oiTrend: 'нет данных' },
      () => getOpenInterest(normalizedSymbol)
    ),
    safeRequest(`Funding rate for ${normalizedSymbol}`, 0, () => getFundingRate(normalizedSymbol)),
    safeRequest(
      `Ticker for ${normalizedSymbol}`,
      { symbol: normalizedSymbol, price: 0, volume24h: 0, priceChange24h: 0 },
      () => getTicker(normalizedSymbol)
    ),
  ]);
  const candles = Array.isArray(priceData.candles) ? priceData.candles : [];
  const volumeStats = candles.length > 0 ? calculateVolumeStats(candles) : getEmptyVolumeStats();
  const price = priceData.currentPrice || ticker.price || 0;

  return {
    symbol: normalizedSymbol,
    price,
    change1h: priceData.change1h || 0,
    volume24h: ticker.volume24h || 0,
    openInterest: openInterestData.openInterest || 0,
    oiChange: openInterestData.oiChange || 0,
    oiTrend: openInterestData.oiTrend || 'нет данных',
    fundingRate: Number.isFinite(Number(fundingRate)) ? Number(fundingRate) : 0,
    klines: candles,
    candles,
    volumeStats,
    volumeTrend: volumeStats.volumeTrend || undefined,
  };
}

async function testConnection() {
  try {
    const data = await request('/fapi/v1/ticker/price', { symbol: 'BTCUSDT' });
    logger.info(`Binance testConnection response: ${JSON.stringify(data)}`);

    const price = Number(data?.price);

    if (!Number.isFinite(price) || price <= 0) {
      return {
        ok: false,
        price: 0,
        error: 'BTCUSDT price missing in Binance response',
      };
    }

    return {
      ok: true,
      price,
      error: '',
    };
  } catch (error) {
    const message = error.response?.data
      ? JSON.stringify(error.response.data)
      : error.message;

    logger.error(`Binance testConnection failed: ${error.stack || error.message}`);

    return {
      ok: false,
      price: 0,
      error: message,
    };
  }
}

module.exports = {
  testConnection,
  getTopCoins,
  getTicker,
  getKlines,
  getPriceChange1h,
  getOpenInterest,
  getFundingRate,
  getFullCoinData,
  getBybitSymbols,
};
