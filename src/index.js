const cron = require('node-cron');
const logger = require('./utils/logger');
const config = require('./config');
const scanner = require('./modules/scanner');
const signals = require('./modules/signals');
const telegram = require('./modules/telegram');
const database = require('./modules/database');
const risk = require('./modules/risk');
const exchange = require('./modules/exchange');

let isScanning = false;
let cronTask = null;
let lastDailyStopNotificationDate = null;

function buildStartupMessage() {
  const dailyLimit = config.INITIAL_DEPOSIT * (config.DAILY_LOSS_LIMIT_PERCENT / 100);

  return [
    '🚀 PumpHunter запущен',
    '',
    `Депозит: $${config.INITIAL_DEPOSIT}`,
    `Дневной лимит: -$${dailyLimit}`,
    `Сканирование: каждые ${config.SCAN_INTERVAL_MINUTES} минут`,
    `Тихие часы: ${String(config.QUIET_HOURS_START).padStart(2, '0')}:00 - ${String(config.QUIET_HOURS_END).padStart(2, '0')}:00 UTC`,
    '',
    '/help — список команд',
  ].join('\n');
}

async function runScan() {
  if (isScanning) {
    logger.warn('Previous scan is still running, skipping this tick');
    return;
  }

  isScanning = true;

  try {
    const pumpedCoins = await scanner.scanMarket();
    const dailyLimit = risk.checkDailyLimit();

    if (dailyLimit.limitReached && pumpedCoins.length > 0) {
      const today = risk.getTodayDate();
      logger.warn('Дневной лимит достигнут, сигнал пропущен');

      if (lastDailyStopNotificationDate !== today) {
        const pnlText = `${dailyLimit.currentPnl < 0 ? '-' : '+'}$${Math.abs(dailyLimit.currentPnl).toFixed(2)}`;
        await telegram.sendSignal(
          `⛔️ СТОП НА СЕГОДНЯ — дневной лимит -$${dailyLimit.limit.toFixed(2)} достигнут. P&L: ${pnlText}`
        );
        lastDailyStopNotificationDate = today;
      }

      logger.info(`Скан завершён, найдено ${pumpedCoins.length} монет, сигналы заблокированы risk manager`);
      return;
    }

    for (const coin of pumpedCoins) {
      const signal = coin.signalType === 'LONG'
        ? signals.generateLongSignal(coin)
        : signals.generateShortSignal(coin);
      const message = signals.formatSignalMessage(signal);

      logger.info(`Сигнал: ${signal.type} ${signal.symbol} ${signal.quality.stars}`);

      const wasSent = await telegram.sendSignal(message);

      if (wasSent) {
        scanner.markSignalSent(coin.symbol);
        database.saveSignal(signal);
      }
    }

    logger.info(`Скан завершён, найдено ${pumpedCoins.length} монет`);
  } catch (error) {
    logger.error(`Market scan failed: ${error.message}`);
  } finally {
    try {
      database.saveDb();
    } catch (error) {
      logger.error(`Database save failed: ${error.message}`);
    }

    isScanning = false;
  }
}

async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down`);

  if (cronTask) {
    cronTask.stop();
  }

  database.saveDb();
  telegram.stopBot(signal);
  process.exit(0);
}

async function main() {
  await database.initDatabase();
  const exchangeConnection = await exchange.testConnection();
  logger.info(`Exchange startup test result: ${JSON.stringify(exchangeConnection)}`);

  await telegram.startBot();
  await telegram.sendNotification(buildStartupMessage());

  const schedule = `*/${config.SCAN_INTERVAL_MINUTES} * * * *`;
  cronTask = cron.schedule(schedule, runScan);

  logger.info(`PumpHunter scanner started. Schedule: every ${config.SCAN_INTERVAL_MINUTES} minutes`);

  await runScan();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

main().catch((error) => {
  logger.error(`Application startup failed: ${error.message}`);
  process.exit(1);
});
