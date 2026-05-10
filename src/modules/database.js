const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const logger = require('../utils/logger');

const ROOT_DIR = path.resolve(__dirname, '../..');
const DB_PATH = path.resolve(process.cwd(), 'pumphunter.db');

let SQL = null;
let db = null;

async function initDatabase() {
  SQL = await initSqlJs({
    locateFile: (filename) => path.join(ROOT_DIR, 'node_modules/sql.js/dist', filename),
  });

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    logger.info('БД загружена из файла: pumphunter.db');
  } else {
    db = new SQL.Database();
    logger.info('БД создана заново: pumphunter.db');
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER,
      symbol TEXT,
      type TEXT,
      price REAL,
      change_1h REAL,
      volume_24h REAL,
      quality_score INTEGER,
      take_profit REAL,
      stop_loss REAL
    );

    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT,
      type TEXT,
      entry_price REAL,
      size_usd REAL,
      opened_at INTEGER,
      closed_at INTEGER,
      close_price REAL,
      pnl_usd REAL,
      status TEXT DEFAULT 'OPEN'
    );

    CREATE TABLE IF NOT EXISTS daily_pnl (
      date TEXT PRIMARY KEY,
      total_pnl REAL DEFAULT 0,
      trades_count INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0
    );
  `);

  saveDb();
}

function getDb() {
  if (!db) {
    throw new Error('Database is not initialized');
  }

  return db;
}

function selectAll(sql, params = []) {
  const database = getDb();
  const statement = database.prepare(sql);
  const rows = [];

  try {
    statement.bind(params);

    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
  } finally {
    statement.free();
  }

  return rows;
}

function selectOne(sql, params = []) {
  return selectAll(sql, params)[0] || null;
}

function saveDb() {
  const database = getDb();
  const data = database.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
  logger.info('Database saved to pumphunter.db');
}

function saveSignal(signalData) {
  const takeProfit = signalData.takeProfit ?? signalData.takeProfit1 ?? null;

  getDb().run(
    `
      INSERT INTO signals (
        timestamp,
        symbol,
        type,
        price,
        change_1h,
        volume_24h,
        quality_score,
        take_profit,
        stop_loss
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      Date.now(),
      signalData.symbol,
      signalData.type,
      signalData.price,
      signalData.change1h,
      signalData.volume24h,
      signalData.quality?.score ?? null,
      takeProfit,
      signalData.stopLoss ?? null,
    ]
  );

  saveDb();
}

function openPosition(symbol, type, entryPrice, sizeUsd) {
  getDb().run(
    `
      INSERT INTO positions (
        symbol,
        type,
        entry_price,
        size_usd,
        opened_at,
        status
      )
      VALUES (?, ?, ?, ?, ?, 'OPEN')
    `,
    [symbol.toUpperCase(), type.toUpperCase(), entryPrice, sizeUsd, Date.now()]
  );

  const position = selectOne('SELECT * FROM positions WHERE id = last_insert_rowid()');
  saveDb();

  return position;
}

function getOpenPositions() {
  return selectAll('SELECT * FROM positions WHERE status = ? ORDER BY opened_at ASC', ['OPEN']);
}

function getPositionBySymbol(symbol) {
  return selectOne(
    'SELECT * FROM positions WHERE symbol = ? AND status = ? ORDER BY opened_at DESC LIMIT 1',
    [symbol.toUpperCase(), 'OPEN']
  );
}

function updateDailyPnl(date, pnlDelta, isWin) {
  getDb().run(
    `
      INSERT OR IGNORE INTO daily_pnl (date, total_pnl, trades_count, wins, losses)
      VALUES (?, 0, 0, 0, 0)
    `,
    [date]
  );

  getDb().run(
    `
      UPDATE daily_pnl
      SET
        total_pnl = total_pnl + ?,
        trades_count = trades_count + 1,
        wins = wins + ?,
        losses = losses + ?
      WHERE date = ?
    `,
    [pnlDelta, isWin ? 1 : 0, isWin ? 0 : 1, date]
  );

  saveDb();
}

function closePosition(id, closePrice) {
  const position = selectOne(
    'SELECT * FROM positions WHERE id = ? AND status = ?',
    [id, 'OPEN']
  );

  if (!position) {
    throw new Error(`Open position not found: ${id}`);
  }

  const entryPrice = Number(position.entry_price);
  const sizeUsd = Number(position.size_usd);
  const pnlPercent = position.type === 'SHORT'
    ? (entryPrice - closePrice) / entryPrice
    : (closePrice - entryPrice) / entryPrice;
  const pnlUsd = sizeUsd * pnlPercent;
  const closedAt = Date.now();

  getDb().run(
    `
      UPDATE positions
      SET closed_at = ?, close_price = ?, pnl_usd = ?, status = 'CLOSED'
      WHERE id = ?
    `,
    [closedAt, closePrice, pnlUsd, id]
  );

  const date = new Date(closedAt).toISOString().slice(0, 10);
  updateDailyPnl(date, pnlUsd, pnlUsd > 0);

  return {
    ...position,
    closed_at: closedAt,
    close_price: closePrice,
    pnl_usd: pnlUsd,
    pnl_percent: pnlPercent * 100,
    status: 'CLOSED',
  };
}

function getDailyPnl(date) {
  const row = selectOne('SELECT * FROM daily_pnl WHERE date = ?', [date]);

  return row || {
    date,
    total_pnl: 0,
    trades_count: 0,
    wins: 0,
    losses: 0,
  };
}

function getWeeklyStats() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 6);
  const startDate = date.toISOString().slice(0, 10);
  const row = selectOne(
    `
      SELECT
        COALESCE(SUM(total_pnl), 0) AS total_pnl,
        COALESCE(SUM(trades_count), 0) AS trades_count,
        COALESCE(SUM(wins), 0) AS wins,
        COALESCE(SUM(losses), 0) AS losses
      FROM daily_pnl
      WHERE date >= ?
    `,
    [startDate]
  );

  return {
    date: startDate,
    total_pnl: Number(row?.total_pnl || 0),
    trades_count: Number(row?.trades_count || 0),
    wins: Number(row?.wins || 0),
    losses: Number(row?.losses || 0),
  };
}

module.exports = {
  initDatabase,
  saveSignal,
  openPosition,
  closePosition,
  getOpenPositions,
  getPositionBySymbol,
  getDailyPnl,
  getWeeklyStats,
  updateDailyPnl,
  saveDb,
};
