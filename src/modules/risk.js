const config = require('../config');
const database = require('./database');

function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
}

function calculatePositionSize(deposit = config.INITIAL_DEPOSIT, riskPercent = 5) {
  return deposit * (riskPercent / 100);
}

function checkDailyLimit() {
  const today = getTodayDate();
  const dailyPnl = database.getDailyPnl(today);
  const limit = config.INITIAL_DEPOSIT * (config.DAILY_LOSS_LIMIT_PERCENT / 100);
  const currentPnl = Number(dailyPnl.total_pnl || 0);

  return {
    limitReached: currentPnl <= -limit,
    currentPnl,
    limit,
  };
}

function isDailyLimitReached() {
  return checkDailyLimit().limitReached;
}

module.exports = {
  calculatePositionSize,
  checkDailyLimit,
  isDailyLimitReached,
  getTodayDate,
};
