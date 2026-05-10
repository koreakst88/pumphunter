const config = require('../config');

function getShortLevels(change1h) {
  if (change1h >= 50) {
    return config.SHORT_LEVELS.PUMP_50_PLUS;
  }

  if (change1h >= 30) {
    return config.SHORT_LEVELS.PUMP_30_50;
  }

  return config.SHORT_LEVELS.PUMP_15_30;
}

function roundPrice(value) {
  if (value >= 100) {
    return Number(value.toFixed(2));
  }

  if (value >= 1) {
    return Number(value.toFixed(4));
  }

  return Number(value.toFixed(8));
}

function formatPrice(value) {
  if (value >= 100) {
    return `$${value.toFixed(2)}`;
  }

  if (value >= 1) {
    return `$${value.toFixed(4)}`;
  }

  return `$${value.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}`;
}

function formatVolume(value) {
  if (value >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(2)}B`;
  }

  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }

  return `$${Math.round(value).toLocaleString('en-US')}`;
}

function formatPercent(value) {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getStars(score, type) {
  if (type === 'LONG') {
    return score >= 2 ? '⭐⭐' : '⭐';
  }

  if (score >= 4) {
    return '⭐⭐⭐';
  }

  if (score === 3) {
    return '⭐⭐';
  }

  return '⭐';
}

function getQualityLabel(score, type) {
  if (type === 'LONG') {
    return score >= 2 ? 'СРЕДНЕЕ' : 'НИЗКОЕ';
  }

  if (score >= 4) {
    return 'ВЫСОКОЕ';
  }

  if (score === 3) {
    return 'СРЕДНЕЕ';
  }

  return 'НИЗКОЕ';
}

function calculateQuality(type, coinData) {
  let score = 0;

  if (type === 'SHORT') {
    if (coinData.fundingRate > config.SHORT_FUNDING_THRESHOLD) {
      score += 1;
    }

    if (coinData.change1h > 30) {
      score += 1;
    }

    if (coinData.change1h > 50) {
      score += 2;
    }
  } else if (type === 'LONG') {
    if (coinData.fundingRate < config.LONG_FUNDING_MAX) {
      score += 1;
    }

    if (coinData.change1h < 15) {
      score += 1;
    }
  } else {
    throw new Error(`Unknown signal type: ${type}`);
  }

  return {
    score,
    stars: getStars(score, type),
    label: getQualityLabel(score, type),
  };
}

function attachMarketData(signal, coinData) {
  return {
    ...signal,
    openInterest: coinData.openInterest,
    oiChange: coinData.oiChange,
    oiTrend: coinData.oiTrend,
    fundingRate: coinData.fundingRate,
    volumeStats: coinData.volumeStats,
    createdAt: new Date(),
  };
}

function generateShortSignal(coinData) {
  const entryPrice = coinData.price;
  const levels = getShortLevels(coinData.change1h);
  const quality = calculateQuality('SHORT', coinData);
  const stopLoss = roundPrice(entryPrice * (1 + levels.stop / 100));
  const takeProfit = roundPrice(entryPrice * (1 - levels.take / 100));

  return attachMarketData({
    type: 'SHORT',
    quality,
    symbol: coinData.symbol,
    price: entryPrice,
    change1h: coinData.change1h,
    volume24h: coinData.volume24h,
    takeProfit,
    stopLoss,
    stopPercent: levels.stop,
    takePercent: levels.take,
    entries: [
      {
        label: 'Вход 1 (сейчас)',
        price: roundPrice(entryPrice),
        positionPercent: 25,
      },
      {
        label: 'Вход 2 (+20% выше)',
        price: roundPrice(entryPrice * 1.2),
        positionPercent: 25,
      },
      {
        label: 'Вход 3 (+40% выше)',
        price: roundPrice(entryPrice * 1.4),
        positionPercent: 50,
      },
    ],
  }, coinData);
}

function generateLongSignal(coinData) {
  const entryPrice = coinData.price;
  const quality = calculateQuality('LONG', coinData);

  return attachMarketData({
    type: 'LONG',
    quality,
    symbol: coinData.symbol,
    price: entryPrice,
    change1h: coinData.change1h,
    volume24h: coinData.volume24h,
    entry: roundPrice(entryPrice),
    averageDown: roundPrice(entryPrice * 0.95),
    stopLoss: roundPrice(entryPrice * (1 - config.LONG_LEVELS.stop / 100)),
    takeProfit1: roundPrice(entryPrice * (1 + config.LONG_LEVELS.take1 / 100)),
    takeProfit2: roundPrice(entryPrice * (1 + config.LONG_LEVELS.take2 / 100)),
    stopPercent: config.LONG_LEVELS.stop,
    take1Percent: config.LONG_LEVELS.take1,
    take2Percent: config.LONG_LEVELS.take2,
  }, coinData);
}

function formatMarketData(signal) {
  const volumeMultiplier = signal.volumeStats?.currentToAverageMultiplier || 0;
  const recentVsPeak = signal.volumeStats?.recentVsPeakRatio || 0;
  const volumeLine = signal.type === 'LONG'
    ? `Объём текущей свечи: ${volumeMultiplier.toFixed(2)}x от среднего`
    : `Объём последних свечей: ${(recentVsPeak * 100).toFixed(0)}% от пикового за час`;

  return [
    `Суточный объём: ${formatVolume(signal.volume24h)}`,
    volumeLine,
    `Open Interest: ${escapeHtml(signal.oiTrend)} (${formatPercent(signal.oiChange)} за час)`,
    `Funding rate: ${formatPercent(signal.fundingRate)}`,
  ].join('\n');
}

function formatShortMessage(signal) {
  const symbol = escapeHtml(signal.symbol);
  const updatedAt = signal.createdAt.toISOString().slice(11, 19);
  const entries = signal.entries
    .map((entry) => `${escapeHtml(entry.label)}: ${formatPrice(entry.price)} - ${entry.positionPercent}% позиции`)
    .join('\n');
  const takeProfit15 = roundPrice(signal.price * 0.92);
  const takeProfit30 = roundPrice(signal.price * 0.88);
  const takeProfit50 = roundPrice(signal.price * 0.85);
  const stopLoss15 = roundPrice(signal.price * 1.12);
  const stopLoss30 = roundPrice(signal.price * 1.18);
  const stopLoss50 = roundPrice(signal.price * 1.25);

  return [
    `🔴 ШОРТ СИГНАЛ: ${symbol}`,
    `${signal.quality.stars} Качество: ${signal.quality.label}`,
    '',
    `📈 Импульс за 1ч: ${formatPercent(signal.change1h)}`,
    `💰 Цена: ${formatPrice(signal.price)}`,
    `📊 Объём 24ч: ${formatVolume(signal.volume24h)}`,
    `💸 Funding: ${formatPercent(signal.fundingRate)}`,
    '',
    '📍 План входа:',
    entries,
    '',
    '🎯 Тейк профит:',
    `  change1h 15-30%: -8% от входа = ${formatPrice(takeProfit15)}`,
    `  change1h 30-50%: -12% от входа = ${formatPrice(takeProfit30)}`,
    `  change1h 50%+:   -15% от входа = ${formatPrice(takeProfit50)}`,
    '',
    '🛑 Стоп лосс:',
    `  change1h 15-30%: +12% от входа = ${formatPrice(stopLoss15)}`,
    `  change1h 30-50%: +18% от входа = ${formatPrice(stopLoss30)}`,
    `  change1h 50%+:   +25% от входа = ${formatPrice(stopLoss50)}`,
    '',
    `⏱ ${updatedAt} UTC`,
  ].join('\n');
}

function formatLongMessage(signal) {
  const symbol = escapeHtml(signal.symbol);
  const updatedAt = signal.createdAt.toISOString().slice(11, 19);

  return [
    `🟢 ЛОНГ СИГНАЛ: ${symbol}`,
    `${signal.quality.stars} Качество: ${signal.quality.label}`,
    '',
    `📈 Импульс за 1ч: ${formatPercent(signal.change1h)}`,
    `💰 Цена: ${formatPrice(signal.price)}`,
    `📊 Объём 24ч: ${formatVolume(signal.volume24h)}`,
    `💸 Funding: ${formatPercent(signal.fundingRate)}`,
    '',
    `📍 Вход: ${formatPrice(signal.entry)}`,
    `🛑 Стоп: -${signal.stopPercent}% = ${formatPrice(signal.stopLoss)}`,
    '',
    '🎯 Тейки:',
    `TP1: +${signal.take1Percent}% = ${formatPrice(signal.takeProfit1)} - закрыть 50%`,
    `TP2: +${signal.take2Percent}% = ${formatPrice(signal.takeProfit2)} - закрыть 30%`,
    'Остаток 20%: трейлинг стоп',
    '',
    `⏱ ${updatedAt} UTC`,
  ].join('\n');
}

function formatSignalMessage(signal) {
  if (signal.type === 'SHORT') {
    return formatShortMessage(signal);
  }

  if (signal.type === 'LONG') {
    return formatLongMessage(signal);
  }

  throw new Error(`Unknown signal type: ${signal.type}`);
}

module.exports = {
  calculateQuality,
  generateShortSignal,
  generateLongSignal,
  formatSignalMessage,
};
