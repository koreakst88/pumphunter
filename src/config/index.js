const dotenv = require('dotenv');

dotenv.config({ quiet: true });

module.exports = {
  // Env
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  CLOUDFLARE_PROXY_URL: process.env.CLOUDFLARE_PROXY_URL || null,

  // Exchange
  EXCHANGE: 'binance',
  BINANCE_BASE_URL: 'https://fapi.binance.com',

  // Coin filters
  MIN_VOLUME_24H: 30_000_000,
  TOP_COINS_COUNT: 500,
  EXCLUDED_PAIRS: [],

  // SHORT signal conditions
  SHORT_MIN_PUMP: 50,
  SHORT_VOLUME_DECREASE_CANDLES: 3,
  SHORT_FUNDING_THRESHOLD: 0.3,

  // LONG signal conditions
  LONG_MIN_PUMP: 15,
  LONG_MAX_PUMP: 25,
  LONG_VOLUME_MULTIPLIER: 3,
  LONG_FUNDING_MAX: 0.1,

  // Take/stop levels
  SHORT_LEVELS: {
    PUMP_50_70: { stop: 12, take: 8 },
    PUMP_70_100: { stop: 18, take: 12 },
    PUMP_100_PLUS: { stop: 25, take: 15 },
  },

  LONG_LEVELS: {
    stop: 8,
    take1: 20,
    take2: 40,
    trailing: true,
  },

  // Risk management
  INITIAL_DEPOSIT: 500,
  DAILY_LOSS_LIMIT_PERCENT: 10,
  MAX_ANALYZE_PER_DAY: 20,

  // Timing
  SCAN_INTERVAL_MINUTES: 5,
  SIGNAL_COOLDOWN_HOURS: 2,
  RATE_LIMIT_DELAY_MS: 100,

  // Modes
  QUIET_HOURS_START: 0,
  QUIET_HOURS_END: 8,

  // API
  COINGLASS_ENABLED: false,
};
