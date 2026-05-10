const WebSocket = require('ws');
const exchange = require('./exchange');
const config = require('../config');
const logger = require('../utils/logger');

const BINANCE_MINI_TICKER_WS_URLS = [
  'wss://fstream.binance.com/ws/!miniTicker@arr',
  'wss://fstream.binancefuture.com/ws/!miniTicker@arr',
];
const lastSignalSentAt = new Map();
const tickers = new Map();

let ws = null;
let reconnectTimer = null;
let scanTimer = null;
let firstMessageTimer = null;
let wsEndpointIndex = 0;
let reconnectAttempts = 0;
let scanHandler = null;

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
  const explicitChange24h = Number(ticker.P ?? ticker.p);

  if (!symbol || !symbol.endsWith('USDT') || !Number.isFinite(price) || price <= 0) {
    return null;
  }

  const change24h = Number.isFinite(explicitChange24h)
    ? explicitChange24h
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
    change24h,
    volume24h,
    updatedAt: Date.now(),
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
          tickers.set(ticker.symbol, ticker);
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

async function scanMarket() {
  logger.info(`Starting market scan from WebSocket cache, tickers=${tickers.size}`);

  const candidates = Array.from(tickers.values())
    .filter((coin) => Number.isFinite(coin.volume24h) && coin.volume24h >= config.MIN_VOLUME_24H)
    .filter((coin) => Number.isFinite(coin.change24h) && coin.change24h > 10)
    .filter((coin) => canSendSignal(coin.symbol))
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, config.TOP_COINS_COUNT);

  logger.info(`Pre-filtered ${candidates.length} candidates from WebSocket cache with 24h change > 10%`);

  const signalCandidates = [];

  for (const coin of candidates) {
    try {
      const coinData = await exchange.getFullCoinData(coin.symbol);

      if (coinData.change1h >= config.SHORT_MIN_PUMP) {
        signalCandidates.push({
          ...coinData,
          signalType: 'SHORT',
        });
        continue;
      }

      if (coinData.change1h >= config.LONG_MIN_PUMP && coinData.change1h < 30) {
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
};
