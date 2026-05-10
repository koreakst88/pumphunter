const config = require('../config');

function getShortLevels(change1h) {
  if (change1h >= 100) {
    return config.SHORT_LEVELS.PUMP_100_PLUS;
  }

  if (change1h >= 70) {
    return config.SHORT_LEVELS.PUMP_70_100;
  }

  return config.SHORT_LEVELS.PUMP_50_70;
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

function getStars(score) {
  if (score >= 4) {
    return '⭐⭐⭐';
  }

  if (score === 3) {
    return '⭐⭐';
  }

  return '⭐';
}

function getQualityLabel(score) {
  if (score >= 4) {
    return 'ВЫСОКОЕ';
  }

  if (score === 3) {
    return 'СРЕДНЕЕ';
  }

  return 'НИЗКОЕ';
}

function calculateQuality(type, coinData) {
  const factors = [];
  const volumeStats = coinData.volumeStats || {};

  if (type === 'SHORT') {
    factors.push(Boolean(volumeStats.isRecentVolumeFallingFromPeak));
    factors.push(coinData.fundingRate > config.SHORT_FUNDING_THRESHOLD);
    factors.push(coinData.oiChange <= 0);
    factors.push(coinData.change1h > 70);
  } else if (type === 'LONG') {
    factors.push((volumeStats.currentToAverageMultiplier || 0) >= config.LONG_VOLUME_MULTIPLIER);
    factors.push(coinData.oiChange > 5);
    factors.push(coinData.fundingRate < config.LONG_FUNDING_MAX);
    factors.push(coinData.change1h >= 15 && coinData.change1h <= 20);
  } else {
    throw new Error(`Unknown signal type: ${type}`);
  }

  const score = factors.filter(Boolean).length;

  return {
    score,
    stars: getStars(score),
    label: getQualityLabel(score),
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
        label: 'Вход 2 (цена +20%)',
        price: roundPrice(entryPrice * 1.2),
        positionPercent: 25,
      },
      {
        label: 'Вход 3 (цена +40%)',
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
    .map((entry) => `${escapeHtml(entry.label)}: ${formatPrice(entry.price)} — ${entry.positionPercent}% позиции`)
    .join('\n');

  return [
    `<b>🔴 ШОРТ СИГНАЛ: ${symbol}</b>`,
    '',
    `${signal.quality.stars} Качество сигнала: <b>${signal.quality.label}</b>`,
    '',
    '<b>📈 Движение:</b>',
    `Рост за 1ч: ${formatPercent(signal.change1h)}`,
    `Текущая цена: ${formatPrice(signal.price)}`,
    '',
    '<b>📊 Данные:</b>',
    formatMarketData(signal),
    '',
    '<b>📍 Рекомендуемый план входа:</b>',
    '',
    entries,
    '',
    `🎯 Тейк профит: ${formatPrice(signal.takeProfit)} (-${signal.takePercent}% от входа 1)`,
    `🛑 Стоп лосс: ${formatPrice(signal.stopLoss)} (+${signal.stopPercent}% от входа 1)`,
    '',
    `⏱ Обновлено: ${updatedAt} UTC`,
  ].join('\n');
}

function formatLongMessage(signal) {
  const symbol = escapeHtml(signal.symbol);
  const updatedAt = signal.createdAt.toISOString().slice(11, 19);

  return [
    `<b>🟢 ЛОНГ СИГНАЛ: ${symbol}</b>`,
    '',
    `${signal.quality.stars} Качество сигнала: <b>${signal.quality.label}</b>`,
    '',
    '<b>📈 Движение:</b>',
    `Рост за 1ч: ${formatPercent(signal.change1h)}`,
    `Текущая цена: ${formatPrice(signal.price)}`,
    '',
    '<b>📊 Данные:</b>',
    formatMarketData(signal),
    '',
    '<b>📍 Рекомендация:</b>',
    '',
    `Вход: ${formatPrice(signal.entry)} — 50% позиции`,
    `Усреднение: ${formatPrice(signal.averageDown)} (-5%) — 50% позиции`,
    '',
    '<b>🎯 Тейки:</b>',
    `TP1: ${formatPrice(signal.takeProfit1)} (+${signal.take1Percent}%) — закрыть 50%`,
    `TP2: ${formatPrice(signal.takeProfit2)} (+${signal.take2Percent}%) — закрыть 30%`,
    'Остаток 20%: трейлинг стоп',
    '',
    `🛑 Стоп лосс: ${formatPrice(signal.stopLoss)} (-${signal.stopPercent}%)`,
    '',
    `⏱ Обновлено: ${updatedAt} UTC`,
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
