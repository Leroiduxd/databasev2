// db.js
// Base de données ultra-légère pour synchroniser les trades.
// Les IDs sont fournis par le Smart Contract (pas d'autoincrement).

const Database = require("better-sqlite3");
const DB_PATH = process.env.DB_PATH || "trades.db";

const db = new Database(DB_PATH, process.env.SQL_VERBOSE === "1"
  ? { verbose: console.log }
  : {}
);

// WAL pour des meilleures performances en lecture/écriture
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
      closeTimestamp INTEGER,
      fundingIndex TEXT,
      closePrice INTEGER,
      lotSize INTEGER,
      closedLotSize INTEGER NOT NULL DEFAULT 0,
      stopLoss INTEGER NOT NULL DEFAULT 0,
      takeProfit INTEGER NOT NULL DEFAULT 0,
      lpLockedCapital TEXT,
      marginUsdc TEXT,
      totalFeesPaidUsdc TEXT
    );
  `);

  // Index essentiels pour des requêtes rapides
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trader ON trades(trader);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_state_asset ON trades(state, assetId);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entry_match ON trades(assetId, state, isLimit, isLong, openPrice);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_exit_match ON trades(assetId, state, isLong, stopLoss, takeProfit);`);
}

initDb();

const stmt = {
  // --- LECTURE SIMPLE ---
  getTradeById: db.prepare(`SELECT * FROM trades WHERE id = ?;`),
  
  // Récupérer tous les trades d'un utilisateur (historique ou en cours)
  getTradesByTrader: db.prepare(`SELECT * FROM trades WHERE trader = ? ORDER BY id DESC;`),
  
  // Ordres en attente d'exécution (state = 0)
  getOrdersByAssetId: db.prepare(`SELECT * FROM trades WHERE state = 0 AND assetId = ?;`),
  
  // Positions ouvertes (state = 1)
  getOpenTradesByAssetId: db.prepare(`SELECT * FROM trades WHERE state = 1 AND assetId = ?;`),

  // --- MOTEUR D'EXÉCUTION (MATCHING) ---
  
  // Trouver les ordres (state 0) dont le prix d'entrée est touché
  matchEntry: db.prepare(`
    SELECT id, CASE WHEN isLimit = 1 THEN 'limit' ELSE 'stop' END AS kind
    FROM trades
    WHERE assetId = ? AND state = 0
      AND (
        (isLimit = 1 AND ((isLong = 1 AND ? <= openPrice) OR (isLong = 0 AND ? >= openPrice)))
        OR 
        (isLimit = 0 AND ((isLong = 1 AND ? >= openPrice) OR (isLong = 0 AND ? <= openPrice)))
      );
  `),

  // Trouver les positions (state 1) qui touchent leur Take Profit ou Stop Loss
  matchExits: db.prepare(`
    SELECT id,
      CASE 
        WHEN stopLoss != 0 AND ((isLong = 1 AND ? <= stopLoss) OR (isLong = 0 AND ? >= stopLoss)) THEN 'stopLoss'
        WHEN takeProfit != 0 AND ((isLong = 1 AND ? >= takeProfit) OR (isLong = 0 AND ? <= takeProfit)) THEN 'takeProfit'
      END AS kind
    FROM trades
    WHERE assetId = ? AND state = 1
      AND (
        (stopLoss != 0 AND ((isLong = 1 AND ? <= stopLoss) OR (isLong = 0 AND ? >= stopLoss)))
        OR 
        (takeProfit != 0 AND ((isLong = 1 AND ? >= takeProfit) OR (isLong = 0 AND ? <= takeProfit)))
      );
  `),

  // --- ÉCRITURE (PRÉPARATION) ---
  upsertTrade: db.prepare(`
    INSERT INTO trades (
      id, trader, assetId, isLong, isLimit, leverage, openPrice, state, 
      openTimestamp, closeTimestamp, fundingIndex, closePrice, lotSize, 
      closedLotSize, stopLoss, takeProfit, lpLockedCapital, marginUsdc, totalFeesPaidUsdc
    ) VALUES (
      @id, @trader, @assetId, @isLong, @isLimit, @leverage, @openPrice, @state, 
      @openTimestamp, @closeTimestamp, @fundingIndex, @closePrice, @lotSize, 
      @closedLotSize, @stopLoss, @takeProfit, @lpLockedCapital, @marginUsdc, @totalFeesPaidUsdc
    )
    ON CONFLICT(id) DO UPDATE SET
      trader=excluded.trader, assetId=excluded.assetId, isLong=excluded.isLong, 
      isLimit=excluded.isLimit, leverage=excluded.leverage, openPrice=excluded.openPrice, 
      state=excluded.state, openTimestamp=excluded.openTimestamp, closeTimestamp=excluded.closeTimestamp, 
      fundingIndex=excluded.fundingIndex, closePrice=excluded.closePrice, lotSize=excluded.lotSize, 
      closedLotSize=excluded.closedLotSize, stopLoss=excluded.stopLoss, takeProfit=excluded.takeProfit, 
      lpLockedCapital=excluded.lpLockedCapital, marginUsdc=excluded.marginUsdc, totalFeesPaidUsdc=excluded.totalFeesPaidUsdc;
  `),

  patchState: db.prepare(`
    UPDATE trades 
    SET state = COALESCE(@state, state), 
        closePrice = COALESCE(@closePrice, closePrice), 
        closeTimestamp = COALESCE(@closeTimestamp, closeTimestamp),
        closedLotSize = COALESCE(@closedLotSize, closedLotSize)
    WHERE id = @id;
  `),
};

// --- TRANSACTIONS ---
const tx = {
  // Créer ou écraser un trade complet (appelé lors de l'écoute des events du smart contract)
  upsertTrade: db.transaction((payload) => {
    stmt.upsertTrade.run(payload);
    return stmt.getTradeById.get(payload.id);
  }),

  // Mettre à jour en masse le statut des trades (ex: passage de state 0 à 1, ou 1 à 2)
  batchPatchStates: db.transaction((patches) => {
    let updated = 0;
    for (const p of patches) {
      const info = stmt.patchState.run(p);
      if (info.changes) updated += 1;
    }
    return updated;
  })
};

module.exports = { db, stmt, tx };