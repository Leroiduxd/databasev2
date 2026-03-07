// db.js
// All SQL + prepared statements live here.
// Trade IDs are PROVIDED BY YOU (no autoincrement).

const Database = require("better-sqlite3");
const { generateAndSaveTraderCard } = require("./services/image.service");

const DB_PATH = process.env.DB_PATH || "trades.db";

const db = new Database(DB_PATH, process.env.SQL_VERBOSE === "1"
  ? { verbose: console.log }
  : {}
);

// WAL for better concurrency
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY,
      trader TEXT NOT NULL,
      assetId INTEGER NOT NULL,
      isLong INTEGER NOT NULL,
      isLimit INTEGER NOT NULL DEFAULT 0,
      leverage INTEGER,
      openPrice INTEGER,
      state INTEGER,
      openTimestamp INTEGER,
      fundingIndex TEXT,
      closePrice INTEGER,
      lotSize INTEGER,
      closedLotSize INTEGER NOT NULL DEFAULT 0,
      stopLoss INTEGER NOT NULL DEFAULT 0,
      takeProfit INTEGER NOT NULL DEFAULT 0,
      lpLockedCapital TEXT,
      marginUsdc TEXT
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_trader ON trades(trader);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trader_state_id ON trades(trader, state, id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entry_fast ON trades(assetId, state, isLimit, isLong, openPrice);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sl_fast ON trades(assetId, state, isLong, stopLoss);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tp_fast ON trades(assetId, state, isLong, takeProfit);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS trades_metrics (
      id INTEGER PRIMARY KEY,           
      trader TEXT NOT NULL,
      volume INTEGER,
      pnl INTEGER
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_metrics_trader ON trades_metrics(trader);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_metrics_pnl ON trades_metrics(pnl);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_metrics_vol ON trades_metrics(volume);`);

  db.exec(`DROP TRIGGER IF EXISTS trg_metrics_insert;`);
  db.exec(`DROP TRIGGER IF EXISTS trg_metrics_update;`);

  db.exec(`
    CREATE TRIGGER trg_metrics_insert
    AFTER INSERT ON trades
    WHEN new.state IN (1, 2)
    BEGIN
      INSERT INTO trades_metrics (id, trader, volume, pnl)
      VALUES (
        new.id, new.trader,
        CAST(new.openPrice * new.lotSize * (CASE new.assetId WHEN 0 THEN 0.01 WHEN 1 THEN 0.01 WHEN 5500 THEN 0.01 WHEN 5501 THEN 0.1 WHEN 90 THEN 10 WHEN 14 THEN 100 WHEN 16 THEN 100 WHEN 3 THEN 1000 WHEN 15 THEN 1000 ELSE 1 END) AS INTEGER),
        CASE WHEN new.state = 2 THEN 
          CAST((CASE WHEN new.isLong = 1 THEN (new.closePrice - new.openPrice) ELSE (new.openPrice - new.closePrice) END) * new.lotSize * (CASE new.assetId WHEN 0 THEN 0.01 WHEN 1 THEN 0.01 WHEN 5500 THEN 0.01 WHEN 5501 THEN 0.1 WHEN 90 THEN 10 WHEN 14 THEN 100 WHEN 16 THEN 100 WHEN 3 THEN 1000 WHEN 15 THEN 1000 ELSE 1 END) AS INTEGER)
        ELSE NULL END
      )
      ON CONFLICT(id) DO UPDATE SET volume = excluded.volume, pnl = excluded.pnl;
    END;
  `);

  db.exec(`
    CREATE TRIGGER trg_metrics_update
    AFTER UPDATE OF state, closePrice, lotSize, openPrice ON trades
    WHEN new.state IN (1, 2)
    BEGIN
      INSERT INTO trades_metrics (id, trader, volume, pnl)
      VALUES (
        new.id, new.trader,
        CAST(new.openPrice * new.lotSize * (CASE new.assetId WHEN 0 THEN 0.01 WHEN 1 THEN 0.01 WHEN 5500 THEN 0.01 WHEN 5501 THEN 0.1 WHEN 90 THEN 10 WHEN 14 THEN 100 WHEN 16 THEN 100 WHEN 3 THEN 1000 WHEN 15 THEN 1000 ELSE 1 END) AS INTEGER),
        CASE WHEN new.state = 2 THEN 
          CAST((CASE WHEN new.isLong = 1 THEN (new.closePrice - new.openPrice) ELSE (new.openPrice - new.closePrice) END) * new.lotSize * (CASE new.assetId WHEN 0 THEN 0.01 WHEN 1 THEN 0.01 WHEN 5500 THEN 0.01 WHEN 5501 THEN 0.1 WHEN 90 THEN 10 WHEN 14 THEN 100 WHEN 16 THEN 100 WHEN 3 THEN 1000 WHEN 15 THEN 1000 ELSE 1 END) AS INTEGER)
        ELSE NULL END
      )
      ON CONFLICT(id) DO UPDATE SET volume = excluded.volume, pnl = excluded.pnl;
    END;
  `);

  db.exec(`
    INSERT INTO trades_metrics (id, trader, volume, pnl)
    SELECT id, trader,
      CAST(openPrice * lotSize * (CASE assetId WHEN 0 THEN 0.01 WHEN 1 THEN 0.01 WHEN 5500 THEN 0.01 WHEN 5501 THEN 0.1 WHEN 90 THEN 10 WHEN 14 THEN 100 WHEN 16 THEN 100 WHEN 3 THEN 1000 WHEN 15 THEN 1000 ELSE 1 END) AS INTEGER),
      CASE WHEN state = 2 THEN 
        CAST((CASE WHEN isLong = 1 THEN (closePrice - openPrice) ELSE (openPrice - closePrice) END) * lotSize * (CASE assetId WHEN 0 THEN 0.01 WHEN 1 THEN 0.01 WHEN 5500 THEN 0.01 WHEN 5501 THEN 0.1 WHEN 90 THEN 10 WHEN 14 THEN 100 WHEN 16 THEN 100 WHEN 3 THEN 1000 WHEN 15 THEN 1000 ELSE 1 END) AS INTEGER)
      ELSE NULL END
    FROM trades
    WHERE state IN (1, 2)
    ON CONFLICT(id) DO UPDATE SET volume = excluded.volume, pnl = excluded.pnl;
  `);
}

initDb();

const stmt = {
  getTradeById: db.prepare(`SELECT * FROM trades WHERE id = ?;`),
  getMaxTradeId: db.prepare(`SELECT MAX(id) as maxId FROM trades;`),
  getTotalTraders: db.prepare(`SELECT COUNT(DISTINCT trader) as totalTraders FROM trades;`),
  
  getOpenStatsPerAssetAndDirection: db.prepare(`
    SELECT assetId, isLong, COUNT(*) as openCount, AVG(leverage) as avgLeverage
    FROM trades WHERE state = 1 GROUP BY assetId, isLong;
  `),
  
  getTop100Pnl: db.prepare(`SELECT trader, SUM(pnl) as pnl FROM trades_metrics WHERE pnl IS NOT NULL GROUP BY trader ORDER BY pnl DESC LIMIT ?;`),
  getTop100Volume: db.prepare(`SELECT trader, SUM(volume) as volume FROM trades_metrics GROUP BY trader ORDER BY volume DESC LIMIT ?;`),
  getTop100Trades: db.prepare(`SELECT trader, COUNT(id) as totalTrades FROM trades GROUP BY trader ORDER BY totalTrades DESC LIMIT ?;`),

  getTraderRankByActivity: db.prepare(`
    WITH Ranked AS (SELECT trader, COUNT(*) as tradesCount, RANK() OVER (ORDER BY COUNT(*) DESC) as rank FROM trades GROUP BY trader)
    SELECT rank, tradesCount FROM Ranked WHERE trader = ?;
  `),
  getTraderRankByVolume: db.prepare(`
    WITH Ranked AS (SELECT trader, SUM(volume) as totalVolume, RANK() OVER (ORDER BY COALESCE(SUM(volume), 0) DESC) as rank FROM trades_metrics GROUP BY trader)
    SELECT rank, totalVolume FROM Ranked WHERE trader = ?;
  `),
  getTraderRankByPnl: db.prepare(`
    WITH Ranked AS (SELECT trader, SUM(pnl) as totalPnl, RANK() OVER (ORDER BY COALESCE(SUM(pnl), 0) DESC) as rank FROM trades_metrics WHERE pnl IS NOT NULL GROUP BY trader)
    SELECT rank, totalPnl FROM Ranked WHERE trader = ?;
  `),
  // --- TRADES OUVERTS PAR ACTIF ---
  getOpenTradesByAssetId: db.prepare(`
    SELECT * FROM trades 
    WHERE state = 1 AND assetId = ?;
  `),

  getOrdersByAssetId: db.prepare(`
    SELECT * FROM trades 
    WHERE state = 0 AND assetId = ?;
  `),

  // --- TRADES FERMÉS (STATE 2) PAR ACTIF ---
  getClosedTradesByAssetId: db.prepare(`
    SELECT * FROM trades 
    WHERE state = 2 AND assetId = ?;
  `),

  getTopTradersAll: db.prepare(`SELECT trader, COUNT(*) as count FROM trades GROUP BY trader ORDER BY count DESC LIMIT ?;`),
  getTopTradersByState: db.prepare(`SELECT trader, COUNT(*) as count FROM trades WHERE state = ? GROUP BY trader ORDER BY count DESC LIMIT ?;`),
  getAllUniqueTraders: db.prepare(`SELECT DISTINCT trader FROM trades;`),

  getTraderMetrics: db.prepare(`SELECT trader, SUM(pnl) as totalPnl, SUM(volume) as totalVolume FROM trades_metrics WHERE trader = ?;`),
  getTopTradersByVolume: db.prepare(`SELECT trader, SUM(volume) as totalVolume FROM trades_metrics GROUP BY trader ORDER BY totalVolume DESC LIMIT ?;`),
  getTopTradersByPnl: db.prepare(`SELECT trader, SUM(pnl) as totalPnl FROM trades_metrics WHERE pnl IS NOT NULL GROUP BY trader ORDER BY totalPnl DESC LIMIT ?;`),
  getTopTradesByPnl: db.prepare(`SELECT t.*, m.pnl, m.volume FROM trades_metrics m JOIN trades t ON t.id = m.id WHERE m.pnl IS NOT NULL ORDER BY m.pnl DESC LIMIT ?;`),

  getTraderIdsAll: db.prepare(`SELECT id FROM trades WHERE trader = ? ORDER BY id DESC;`),
  getTraderIdsByState: db.prepare(`SELECT id FROM trades WHERE trader = ? AND state = ? ORDER BY id DESC;`),

  matchEntry: db.prepare(`
    SELECT id, CASE WHEN isLimit = 1 THEN 'limit' ELSE 'stop' END AS kind
    FROM trades
    WHERE assetId = ? AND state = 0
      AND ((isLimit = 1 AND ((isLong = 1 AND ? <= openPrice) OR (isLong = 0 AND ? >= openPrice)))
        OR (isLimit = 0 AND ((isLong = 1 AND ? >= openPrice) OR (isLong = 0 AND ? <= openPrice))));
  `),

  matchExits: db.prepare(`
    SELECT id,
      CASE WHEN stopLoss != 0 AND ((isLong = 1 AND ? <= stopLoss) OR (isLong = 0 AND ? >= stopLoss)) THEN 'stopLoss'
           WHEN takeProfit != 0 AND ((isLong = 1 AND ? >= takeProfit) OR (isLong = 0 AND ? <= takeProfit)) THEN 'takeProfit'
           ELSE NULL END AS kind
    FROM trades
    WHERE assetId = ? AND state = 1
      AND ((stopLoss != 0 AND ((isLong = 1 AND ? <= stopLoss) OR (isLong = 0 AND ? >= stopLoss)))
        OR (takeProfit != 0 AND ((isLong = 1 AND ? >= takeProfit) OR (isLong = 0 AND ? <= takeProfit))));
  `),

  getVolume24h: db.prepare(`SELECT SUM(m.volume) as volume24h FROM trades_metrics m JOIN trades t ON t.id = m.id WHERE t.state IN (1, 2) AND t.openTimestamp >= ?;`),
};

// --------------------
// WRITE statements
// --------------------
const upsertTradeSql = `
  INSERT INTO trades (
    id, trader, assetId, isLong, isLimit, leverage, openPrice, state, openTimestamp, fundingIndex, closePrice, lotSize, closedLotSize, stopLoss, takeProfit, lpLockedCapital, marginUsdc
  ) VALUES (
    @id, @trader, @assetId, @isLong, @isLimit, @leverage, @openPrice, @state, @openTimestamp, @fundingIndex, @closePrice, @lotSize, @closedLotSize, @stopLoss, @takeProfit, @lpLockedCapital, @marginUsdc
  )
  ON CONFLICT(id) DO UPDATE SET
    trader=excluded.trader, assetId=excluded.assetId, isLong=excluded.isLong, isLimit=excluded.isLimit, leverage=excluded.leverage, openPrice=excluded.openPrice, state=excluded.state, openTimestamp=excluded.openTimestamp, fundingIndex=excluded.fundingIndex, closePrice=excluded.closePrice, lotSize=excluded.lotSize, closedLotSize=excluded.closedLotSize, stopLoss=excluded.stopLoss, takeProfit=excluded.takeProfit, lpLockedCapital=excluded.lpLockedCapital, marginUsdc=excluded.marginUsdc;
`;

stmt.upsertTrade = db.prepare(upsertTradeSql);
stmt.patchTrade = db.prepare(`UPDATE trades SET state = COALESCE(@state, state), closePrice = COALESCE(@closePrice, closePrice), stopLoss = COALESCE(@stopLoss, stopLoss), takeProfit = COALESCE(@takeProfit, takeProfit), closedLotSize = COALESCE(@closedLotSize, closedLotSize), marginUsdc = COALESCE(@marginUsdc, marginUsdc), lpLockedCapital = COALESCE(@lpLockedCapital, lpLockedCapital), fundingIndex = COALESCE(@fundingIndex, fundingIndex) WHERE id = @id;`);
stmt.patchState = db.prepare(`UPDATE trades SET state = COALESCE(@state, state), closePrice = COALESCE(@closePrice, closePrice), closedLotSize = COALESCE(@closedLotSize, closedLotSize), fundingIndex = COALESCE(@fundingIndex, fundingIndex) WHERE id = @id`);
stmt.patchSLTP = db.prepare(`UPDATE trades SET stopLoss = COALESCE(@stopLoss, stopLoss), takeProfit = COALESCE(@takeProfit, takeProfit) WHERE id = @id`);

function triggerCardUpdate(trader) {
  if (!trader) return;
  setImmediate(() => {
    try {
      const actRow = stmt.getTraderRankByActivity.get(trader);
      const volRow = stmt.getTraderRankByVolume.get(trader);
      const pnlRow = stmt.getTraderRankByPnl.get(trader);
      
      const ranks = {
        activity: { rank: actRow?.rank, value: actRow?.tradesCount || 0 },
        volume: { rank: volRow?.rank, value: volRow?.totalVolume || 0 },
        pnl: { rank: pnlRow?.rank, value: pnlRow?.totalPnl || 0 }
      };
      
      generateAndSaveTraderCard(trader, ranks);
    } catch (e) {
      console.error("[db.js] Error updating card for", trader, e);
    }
  });
}

const tx = {
  upsertTrade: db.transaction((payload) => {
    stmt.upsertTrade.run(payload);
    const t = stmt.getTradeById.get(payload.id);
    if (t) triggerCardUpdate(t.trader);
    return t;
  }),

  patchTrade: db.transaction((payload) => {
    const info = stmt.patchTrade.run(payload);
    if (info.changes === 0) return null;
    const t = stmt.getTradeById.get(payload.id);
    if (t) triggerCardUpdate(t.trader);
    return t;
  }),

  batchPatchStates: db.transaction((patches) => {
    let updated = 0;
    const tradersToUpdate = new Set();
    
    for (const p of patches) {
      const info = stmt.patchState.run(p);
      if (info.changes) {
        updated += 1;
        const t = stmt.getTradeById.get(p.id);
        if (t) tradersToUpdate.add(t.trader);
      }
    }
    tradersToUpdate.forEach(triggerCardUpdate);
    return updated;
  }),

  batchPatchSLTP: db.transaction((patches) => {
    let updated = 0;
    const tradersToUpdate = new Set();
    
    for (const p of patches) {
      const info = stmt.patchSLTP.run(p);
      if (info.changes) {
        updated += 1;
        const t = stmt.getTradeById.get(p.id);
        if (t) tradersToUpdate.add(t.trader);
      }
    }
    tradersToUpdate.forEach(triggerCardUpdate);
    return updated;
  })
};

module.exports = { db, stmt, tx };