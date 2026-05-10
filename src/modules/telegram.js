const { Markup, Telegraf } = require('telegraf');
const config = require('../config');
const logger = require('../utils/logger');
const exchange = require('./exchange');
const openai = require('./openai');
const signals = require('./signals');
const database = require('./database');
const risk = require('./risk');
const scanner = require('./scanner');

const bot = config.TELEGRAM_BOT_TOKEN ? new Telegraf(config.TELEGRAM_BOT_TOKEN) : null;
const COMMAND_ERROR_MESSAGE = '❌ Ошибка при выполнении команды';
const ANALYSIS_UNAVAILABLE_MESSAGE = '⚠️ Анализ временно недоступен, попробуйте позже';
const TELEGRAM_COMMANDS = [
  { command: 'start', description: 'Запуск бота' },
  { command: 'help', description: 'Список команд' },
  { command: 'scan', description: 'Сканировать монету: /scan SYMBOL' },
  { command: 'analyze', description: 'Анализ позиции: /analyze SYMBOL TYPE PRICE' },
  { command: 'enter', description: 'Открыть позицию: /enter SYMBOL TYPE PRICE' },
  { command: 'close', description: 'Закрыть позицию: /close SYMBOL' },
  { command: 'positions', description: 'Открытые позиции' },
  { command: 'stats', description: 'Статистика: /stats today или /stats week' },
  { command: 'settings', description: 'Настройки бота' },
  { command: 'ping', description: 'Проверка WebSocket сканера' },
];

function isQuietHours(date = new Date()) {
  const currentHour = date.getUTCHours();

  if (config.QUIET_HOURS_START < config.QUIET_HOURS_END) {
    return currentHour >= config.QUIET_HOURS_START && currentHour < config.QUIET_HOURS_END;
  }

  return currentHour >= config.QUIET_HOURS_START || currentHour < config.QUIET_HOURS_END;
}

function normalizeSymbol(symbol) {
  return symbol.trim().toUpperCase();
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

function formatUsd(value) {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatPercent(value) {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function getVolumeTrend(marketData) {
  if (marketData.volumeTrend) {
    return marketData.volumeTrend;
  }

  const volumeStats = marketData.volumeStats || {};

  if (volumeStats.isRecentVolumeFallingFromPeak) {
    return 'падает';
  }

  if ((volumeStats.currentToAverageMultiplier || 0) >= 1.5) {
    return 'растёт';
  }

  return 'стабильно';
}

function calculatePnlPercent(type, entryPrice, currentPrice) {
  if (type === 'SHORT') {
    return ((entryPrice - currentPrice) / entryPrice) * 100;
  }

  return ((currentPrice - entryPrice) / entryPrice) * 100;
}

function calculatePnlUsd(type, entryPrice, currentPrice, sizeUsd) {
  return sizeUsd * (calculatePnlPercent(type, entryPrice, currentPrice) / 100);
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function buildAnalysisMessage(symbol, type, entryPrice, marketData, pnlPercent, aiAnalysis) {
  const volumeTrend = getVolumeTrend(marketData);

  return [
    `📊 АНАЛИЗ ПОЗИЦИИ: ${symbol}`,
    '',
    `Твой вход: ${formatPrice(entryPrice)} (${type})`,
    `Текущая цена: ${formatPrice(marketData.price)}`,
    `P&L: ${formatPercent(pnlPercent)}`,
    '',
    '📈 Рыночные данные:',
    `— Изменение за 1ч: ${formatPercent(marketData.change1h)}`,
    `— Объём 24ч: ${formatVolume(marketData.volume24h)}`,
    `— Тренд объёма: ${volumeTrend}`,
    `— OI за 1ч: ${formatPercent(marketData.oiChange)}`,
    `— Funding: ${formatPercent(marketData.fundingRate)}`,
    '',
    `🤖 ${aiAnalysis.content}`,
  ].join('\n');
}

function buildScanSummary(symbol, marketData) {
  const lines = [
    `📋 СКАН: ${symbol}`,
    '',
    `Цена: ${formatPrice(safeNumber(marketData.price))}`,
    `Изменение 1ч: ${formatPercent(safeNumber(marketData.change1h))}`,
  ];

  lines.push(
    `Объём 24ч: ${formatVolume(safeNumber(marketData.volume24h))}`,
    `Тренд объёма: ${getVolumeTrend(marketData)}`,
    `OI изменение: ${formatPercent(safeNumber(marketData.oiChange))}`,
    `OI тренд: ${marketData.oiTrend || 'нет данных'}`,
    `Funding: ${formatPercent(safeNumber(marketData.fundingRate))}`,
    '',
    '❌ Условия для сигнала не выполнены.'
  );

  return lines.join('\n');
}

function parseAnalyzeArgs(text) {
  const [, symbol, type, entryPriceRaw] = text.trim().split(/\s+/);
  const normalizedType = type ? type.toUpperCase() : null;
  const entryPrice = Number(entryPriceRaw);

  if (!symbol || !['SHORT', 'LONG'].includes(normalizedType) || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    return null;
  }

  return {
    symbol: normalizeSymbol(symbol),
    type: normalizedType,
    entryPrice,
  };
}

function parseEnterArgs(text) {
  const [, symbol, type, entryPriceRaw, sizeRaw] = text.trim().split(/\s+/);
  const normalizedType = type ? type.toUpperCase() : null;
  const entryPrice = Number(entryPriceRaw);
  const sizeUsd = sizeRaw === undefined ? risk.calculatePositionSize() : Number(sizeRaw);

  if (
    !symbol
    || !['SHORT', 'LONG'].includes(normalizedType)
    || !Number.isFinite(entryPrice)
    || entryPrice <= 0
    || !Number.isFinite(sizeUsd)
    || sizeUsd <= 0
  ) {
    return null;
  }

  return {
    symbol: normalizeSymbol(symbol),
    type: normalizedType,
    entryPrice,
    sizeUsd,
  };
}

function parseCloseArgs(text) {
  const [, symbol, closePriceRaw] = text.trim().split(/\s+/);
  const closePrice = closePriceRaw === undefined ? null : Number(closePriceRaw);

  if (!symbol || (closePriceRaw !== undefined && (!Number.isFinite(closePrice) || closePrice <= 0))) {
    return null;
  }

  return {
    symbol: normalizeSymbol(symbol),
    closePrice,
  };
}

function buildStatsMessage(title, stats, includeDailyLimit = false) {
  const tradesCount = Number(stats.trades_count || 0);
  const wins = Number(stats.wins || 0);
  const losses = Number(stats.losses || 0);
  const winRate = tradesCount > 0 ? (wins / tradesCount) * 100 : 0;
  const lines = [
    `📊 ${title}:`,
    '',
    `P&L: ${formatUsd(Number(stats.total_pnl || 0))}`,
    `Сделок: ${tradesCount}`,
    `Выигрышных: ${wins} (${winRate.toFixed(1)}%)`,
    `Убыточных: ${losses}`,
  ];

  if (includeDailyLimit) {
    const dailyLimit = risk.checkDailyLimit();
    lines.push('', `Дневной лимит: ${formatUsd(dailyLimit.currentPnl)} / -$${dailyLimit.limit.toFixed(2)}`);
  }

  return lines.join('\n');
}

function buildMainKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📋 Позиции', 'cmd:positions'),
      Markup.button.callback('📊 Статистика', 'cmd:stats_today'),
    ],
    [
      Markup.button.callback('⚙️ Настройки', 'cmd:settings'),
      Markup.button.callback('❓ Помощь', 'cmd:help'),
    ],
  ]);
}

function getHelpMessage() {
  return [
    '<b>Доступные команды:</b>',
    '',
    '/start — запустить бота',
    '/help — список команд',
    '/scan SYMBOL — ручной скан монеты, пример: /scan BTCUSDT',
    '/analyze SYMBOL TYPE ENTRY_PRICE — анализ позиции, пример: /analyze XYZUSDT short 0.084',
    '/enter SYMBOL TYPE PRICE [SIZE] — открыть позицию, пример: /enter XYZUSDT short 0.084 25',
    '/close SYMBOL [PRICE] — закрыть позицию, пример: /close XYZUSDT 0.077',
    '/positions — список открытых позиций',
    '/stats [today|week] — статистика за день или неделю',
    '/settings — текущие настройки',
    '/ping — проверить WebSocket сканер',
    '',
    'Сканер работает автоматически каждые 5 минут.',
  ].join('\n');
}

function getStartMessage() {
  return [
    '🔴 PumpHunter запущен.',
    '',
    'Я сканирую фьючерсы Binance, ищу LONG/SHORT сигналы и умею анализировать открытую позицию через OpenAI.',
    '',
    'Напиши /help, чтобы увидеть доступные команды.',
  ].join('\n');
}

async function replyHelp(ctx) {
  return ctx.reply(getHelpMessage(), {
    parse_mode: 'HTML',
    ...buildMainKeyboard(),
  });
}

async function replySettings(ctx) {
  try {
    const dailyLimit = config.INITIAL_DEPOSIT * (config.DAILY_LOSS_LIMIT_PERCENT / 100);
    const defaultPositionSize = risk.calculatePositionSize();

    return ctx.reply(
      [
        '⚙️ Текущие настройки:',
        '',
        `Депозит: $${config.INITIAL_DEPOSIT.toFixed(2)}`,
        `Размер позиции по умолчанию: $${defaultPositionSize.toFixed(2)}`,
        `Дневной лимит убытка: -$${dailyLimit.toFixed(2)} (${config.DAILY_LOSS_LIMIT_PERCENT}%)`,
        `Тихие часы: ${String(config.QUIET_HOURS_START).padStart(2, '0')}:00-${String(config.QUIET_HOURS_END).padStart(2, '0')}:00 UTC`,
      ].join('\n')
    );
  } catch (error) {
    logger.error(`/settings failed: ${error.message}`);
    return ctx.reply(COMMAND_ERROR_MESSAGE);
  }
}

async function replyStats(ctx, period = 'today') {
  try {
    if (period === 'week') {
      return ctx.reply(buildStatsMessage('Статистика за неделю', database.getWeeklyStats()));
    }

    const today = risk.getTodayDate();
    return ctx.reply(buildStatsMessage('Статистика за сегодня', database.getDailyPnl(today), true));
  } catch (error) {
    logger.error(`/stats failed: ${error.message}`);
    return ctx.reply(COMMAND_ERROR_MESSAGE);
  }
}

async function replyPositions(ctx) {
  try {
    const positions = database.getOpenPositions();

    if (positions.length === 0) {
      return ctx.reply('📋 Нет открытых позиций');
    }

    const lines = ['📋 Открытые позиции:', ''];

    for (const position of positions) {
      try {
        const ticker = await exchange.getTicker(position.symbol);
        const pnlPercent = calculatePnlPercent(position.type, position.entry_price, ticker.price);
        const pnlUsd = calculatePnlUsd(position.type, position.entry_price, ticker.price, position.size_usd);

        lines.push(
          `${position.symbol} ${position.type}`,
          `Вход: ${formatPrice(position.entry_price)} | Сейчас: ${formatPrice(ticker.price)}`,
          `Размер: $${Number(position.size_usd).toFixed(2)} | P&L: ${formatUsd(pnlUsd)} (${formatPercent(pnlPercent)})`,
          ''
        );
      } catch (error) {
        logger.warn(`Failed to fetch current price for ${position.symbol}: ${error.message}`);
        lines.push(
          `${position.symbol} ${position.type}`,
          `Вход: ${formatPrice(position.entry_price)} | Сейчас: цена недоступна`,
          `Размер: $${Number(position.size_usd).toFixed(2)}`,
          ''
        );
      }
    }

    return ctx.reply(lines.join('\n').trim());
  } catch (error) {
    logger.error(`/positions failed: ${error.message}`);
    return ctx.reply(COMMAND_ERROR_MESSAGE);
  }
}

if (bot) {
  bot.catch((error, ctx) => {
    logger.error(`Telegram handler failed for update ${ctx.update?.update_id}: ${error.message}`);
    return ctx.reply(COMMAND_ERROR_MESSAGE).catch((replyError) => {
      logger.error(`Telegram error reply failed: ${replyError.message}`);
    });
  });

  bot.start((ctx) => {
    return ctx.reply(getStartMessage(), buildMainKeyboard());
  });

  bot.help((ctx) => {
    return replyHelp(ctx);
  });

  bot.command('analyze', async (ctx) => {
    const args = parseAnalyzeArgs(ctx.message.text);

    if (!args) {
      return ctx.reply(
        [
          'Неверный формат команды.',
          '',
          'Используй: /analyze SYMBOL TYPE ENTRY_PRICE',
          'Пример: /analyze XYZUSDT short 0.084',
        ].join('\n')
      );
    }

    try {
      await ctx.reply(`Собираю рыночные данные для ${args.symbol}...`);

      const marketData = await exchange.getFullCoinData(args.symbol);
      const pnlPercent = calculatePnlPercent(args.type, args.entryPrice, marketData.price);
      const volumeTrend = getVolumeTrend(marketData);
      const positionData = {
        symbol: args.symbol,
        type: args.type,
        entryPrice: args.entryPrice,
        currentPrice: marketData.price,
        pnlPercent: Number(pnlPercent.toFixed(2)),
      };
      const aiMarketData = {
        change1h: Number(marketData.change1h.toFixed(2)),
        volume24h: Number(marketData.volume24h.toFixed(2)),
        volumeTrend,
        oiChange: Number(marketData.oiChange.toFixed(2)),
        oiTrend: marketData.oiTrend,
        fundingRate: Number(marketData.fundingRate.toFixed(4)),
      };

      const aiAnalysis = await openai.analyzePosition(positionData, aiMarketData);

      if (aiAnalysis.recommendation === 'НЕДОСТУПНО') {
        return ctx.reply(ANALYSIS_UNAVAILABLE_MESSAGE);
      }

      const message = buildAnalysisMessage(args.symbol, args.type, args.entryPrice, marketData, pnlPercent, aiAnalysis);

      return ctx.reply(message);
    } catch (error) {
      logger.error(`/analyze failed: ${error.message}`);
      return ctx.reply(COMMAND_ERROR_MESSAGE);
    }
  });

  bot.command('scan', async (ctx) => {
    const [, symbolRaw] = ctx.message.text.trim().split(/\s+/);

    if (!symbolRaw) {
      return ctx.reply(
        [
          'Неверный формат команды.',
          '',
          'Используй: /scan SYMBOL',
          'Пример: /scan BTCUSDT',
        ].join('\n')
      );
    }

    const symbol = normalizeSymbol(symbolRaw);

    try {
      logger.info(`Ручной скан: ${symbol}`);

      if (scanner.isWarmingUp()) {
        const minutesLeft = Math.ceil(scanner.getWarmupRemainingMs() / 60_000);
        return ctx.reply(`⏳ Идёт прогрев истории цен. До точного /scan осталось примерно ${minutesLeft} мин.`);
      }

      const marketData = await scanner.getFullCoinDataWS(symbol);
      logger.info(`Результат ручного скана ${symbol}: ${JSON.stringify(marketData)}`);

      if (!scanner.isTradableOnBybit(symbol)) {
        return ctx.reply(`${buildScanSummary(symbol, marketData)}\n\n❌ Монеты нет на Bybit linear, сигнал не отправляется.`);
      }

      const signalType = scanner.getSignalType(marketData);

      if (signalType === 'SHORT') {
        const signal = signals.generateShortSignal(marketData);
        return ctx.reply(signals.formatSignalMessage(signal), { parse_mode: 'HTML' });
      }

      if (signalType === 'LONG') {
        const signal = signals.generateLongSignal(marketData);
        return ctx.reply(signals.formatSignalMessage(signal), { parse_mode: 'HTML' });
      }

      return ctx.reply(buildScanSummary(symbol, marketData));
    } catch (error) {
      logger.error(`/scan failed for ${symbol}: ${error.stack || error.message}`);
      return ctx.reply('⏳ Кэш заполняется, подожди 30 секунд');
    }
  });

  bot.command('ping', async (ctx) => {
    try {
      const price = scanner.getCachedPrice('BTCUSDT');
      const cacheSize = scanner.getCacheSize();

      if (!price) {
        return ctx.reply('⏳ Кэш заполняется, подожди 30 секунд');
      }

      return ctx.reply(`✅ Сканер работает. BTC: ${formatPrice(price)} (из WebSocket кэша, ${cacheSize} монет)`);
    } catch (error) {
      logger.error(`/ping failed: ${error.stack || error.message}`);
      return ctx.reply(COMMAND_ERROR_MESSAGE);
    }
  });

  bot.command('enter', async (ctx) => {
    const args = parseEnterArgs(ctx.message.text);

    if (!args) {
      return ctx.reply(
        [
          'Неверный формат команды.',
          '',
          'Используй: /enter SYMBOL TYPE PRICE [SIZE]',
          'Пример: /enter XYZUSDT short 0.084 25',
        ].join('\n')
      );
    }

    try {
      database.openPosition(args.symbol, args.type, args.entryPrice, args.sizeUsd);
      return ctx.reply(
        `✅ Позиция открыта: ${args.type} ${args.symbol} по ${formatPrice(args.entryPrice)}, размер $${args.sizeUsd.toFixed(2)}`
      );
    } catch (error) {
      logger.error(`/enter failed: ${error.message}`);
      return ctx.reply(COMMAND_ERROR_MESSAGE);
    }
  });

  bot.command('close', async (ctx) => {
    const args = parseCloseArgs(ctx.message.text);

    if (!args) {
      return ctx.reply(
        [
          'Неверный формат команды.',
          '',
          'Используй: /close SYMBOL [PRICE]',
          'Пример: /close XYZUSDT 0.077',
        ].join('\n')
      );
    }

    try {
      const position = database.getPositionBySymbol(args.symbol);

      if (!position) {
        return ctx.reply(`Открытая позиция по ${args.symbol} не найдена.`);
      }

      let closePrice = args.closePrice;

      if (!closePrice) {
        const ticker = await exchange.getTicker(args.symbol);
        closePrice = ticker.price;
      }

      const closedPosition = database.closePosition(position.id, closePrice);

      return ctx.reply(
        `✅ Позиция закрыта: ${closedPosition.type} ${closedPosition.symbol}, P&L: ${formatUsd(closedPosition.pnl_usd)} (${formatPercent(closedPosition.pnl_percent)})`
      );
    } catch (error) {
      logger.error(`/close failed: ${error.message}`);
      return ctx.reply(COMMAND_ERROR_MESSAGE);
    }
  });

  bot.command('positions', async (ctx) => {
    return replyPositions(ctx);
  });

  bot.command('stats', (ctx) => {
    const [, periodRaw] = ctx.message.text.trim().split(/\s+/);
    const period = (periodRaw || 'today').toLowerCase();

    return replyStats(ctx, period);
  });

  bot.command('settings', (ctx) => {
    return replySettings(ctx);
  });

  bot.action('cmd:positions', async (ctx) => {
    await ctx.answerCbQuery('/positions');
    return replyPositions(ctx);
  });

  bot.action('cmd:stats_today', async (ctx) => {
    await ctx.answerCbQuery('/stats today');
    return replyStats(ctx, 'today');
  });

  bot.action('cmd:settings', async (ctx) => {
    await ctx.answerCbQuery('/settings');
    return replySettings(ctx);
  });

  bot.action('cmd:help', async (ctx) => {
    await ctx.answerCbQuery('/help');
    return replyHelp(ctx);
  });
}

async function startBot() {
  if (!bot) {
    logger.warn('Telegram bot token is missing. Bot launch skipped.');
    return;
  }

  try {
    await bot.telegram.setMyCommands(TELEGRAM_COMMANDS);
    logger.info('Telegram command menu registered');
  } catch (error) {
    logger.error(`Telegram command menu registration failed: ${error.message}`);
  }

  bot.launch()
    .then(() => {
      logger.info('Telegram bot started');
    })
    .catch((error) => {
      logger.error(`Telegram bot launch failed: ${error.message}`);
    });

  logger.info('Telegram bot launch requested');
}

async function sendSignal(message) {
  if (!bot || !config.TELEGRAM_CHAT_ID) {
    logger.warn('Telegram token or chat id is missing. Signal was not sent.');
    return false;
  }

  try {
    await bot.telegram.sendMessage(config.TELEGRAM_CHAT_ID, message, {
      parse_mode: 'HTML',
      disable_notification: isQuietHours(),
    });

    logger.info('Telegram signal sent');
    return true;
  } catch (error) {
    logger.error(`Telegram send failed: ${error.message}`);
    return false;
  }
}

async function sendNotification(message) {
  if (!bot || !config.TELEGRAM_CHAT_ID) {
    logger.warn('Telegram token or chat id is missing. Notification was not sent.');
    return false;
  }

  try {
    await bot.telegram.sendMessage(config.TELEGRAM_CHAT_ID, message, {
      disable_notification: isQuietHours(),
    });

    logger.info('Telegram notification sent');
    return true;
  } catch (error) {
    logger.error(`Telegram notification failed: ${error.message}`);
    return false;
  }
}

function stopBot(reason) {
  if (bot) {
    bot.stop(reason);
    logger.info(`Telegram bot stopped: ${reason}`);
  }
}

module.exports = {
  startBot,
  sendSignal,
  sendNotification,
  isQuietHours,
  stopBot,
};
