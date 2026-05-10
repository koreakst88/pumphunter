const bybit = require('./bybit');
const config = require('../config');
const logger = require('../utils/logger');

const lastSignalSentAt = new Map();

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

async function scanMarket() {
  logger.info('Starting market scan');

  let topCoins = [];

  try {
    topCoins = await bybit.getTopCoins();
  } catch (error) {
    logger.error(`Market scan failed while fetching top coins: ${error.message}`);
    return [];
  }

  const candidates = topCoins.filter((coin) => {
    const hasStrong24hMove = Number.isFinite(coin.priceChange24h) && coin.priceChange24h > 10;
    return hasStrong24hMove && canSendSignal(coin.symbol);
  });

  logger.info(`Pre-filtered ${candidates.length} candidates with 24h change > 10%`);

  const signalCandidates = [];

  for (const coin of candidates) {
    try {
      const coinData = await bybit.getFullCoinData(coin.symbol, coin);

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
  scanMarket,
  canSendSignal,
  markSignalSent,
};
