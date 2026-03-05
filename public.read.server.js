// public.read.server.js
// PUBLIC read-only API + PRIVATE write-only API (local only).
// Run this single file. It starts TWO servers:
// - Public READ server (0.0.0.0:3000)  -> safe to expose
// - Private WRITE server (127.0.0.1:3001) -> local only

const express = require("express");
const cors = require("cors"); // <-- AJOUT DE CORS ICI
const { stmt } = require("./db");
const writeRoutes = require("./write.routes");
const { generateTraderCard } = require("./services/image.service");
const path = require("path");
const { LRUCache } = require("lru-cache");

// <-- AJOUT : Import du service des expositions
const { getAllExposures } = require("./services/exposures"); 

const PUBLIC_PORT = Number(process.env.PUBLIC_PORT || 7000);
const PRIVATE_PORT = Number(process.env.PRIVATE_PORT || 7001);

function normalizeAddress(addr) {
  if (typeof addr !== "string") return "";
  return addr.trim().toLowerCase();
}

function toInt(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid ${name}`);
  return Math.trunc(n);
}

function parseMarketE6(query) {
  // market can be: 69000 (human) OR 69000000000 (E6) if unit=e6
  const raw = query.market;
  if (raw === undefined) throw new Error("Missing market");
  const unit = (query.unit || "human").toString().toLowerCase();
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error("Invalid market");

  if (unit === "e6") return Math.trunc(n);
  return Math.round(n * 1e6);
}

// --------------------
// PUBLIC READ server
// --------------------
const readApp = express();

// <-- AJOUT DU MIDDLEWARE CORS POUR L'API PUBLIQUE
readApp.use(cors()); 

readApp.get("/health", (req, res) => res.json({ ok: true, mode: "public-read" }));

// --- NOUVEAUX ENDPOINTS STATISTIQUES ---

// 1. L'ID du plus grand trade
readApp.get("/stats/max-trade-id", (req, res) => {
  try {
    const row = stmt.getMaxTradeId.get();
    const maxId = row && row.maxId !== null ? row.maxId : 0;
    res.json({ success: true, maxId });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch max trade ID" });
  }
});

// 2. Le nombre total de traders uniques
readApp.get("/stats/total-traders", (req, res) => {
  try {
    const row = stmt.getTotalTraders.get();
    const totalTraders = row ? row.totalTraders : 0;
    res.json({ success: true, totalTraders });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch total traders count" });
  }
});

// 3. Les stats des trades ouverts (compte et levier moyen par actif et par sens)
readApp.get("/stats/open-trades", (req, res) => {
  try {
    const rows = stmt.getOpenStatsPerAssetAndDirection.all();
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch open trades stats" });
  }
});

// Volume total exécuté sur les 24 dernières heures
readApp.get("/stats/volume-24h", (req, res) => {
  try {
    // On calcule le timestamp d'il y a 24h pile (en secondes)
    const twentyFourHoursAgo = Math.floor(Date.now() / 1000) - 86400;
    
    // On passe ce timestamp à notre requête SQL
    const row = stmt.getVolume24h.get(twentyFourHoursAgo);
    
    res.json({ 
      success: true, 
      volume24h: row && row.volume24h ? row.volume24h : 0
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch 24h volume" });
  }
});

// ---------------------------------------
// --- NOUVEAUX ENDPOINTS METRIQUES (PNL, VOLUME, CLASSEMENTS) ---

// Liste brute de tous les wallets uniques
readApp.get("/traders/list", (req, res) => {
  try {
    const rows = stmt.getAllUniqueTraders.all();
    const wallets = rows.map((r) => r.trader);
    res.json({ success: true, count: wallets.length, wallets });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch traders list" });
  }
});

// Top Traders par nombre de trades
readApp.get("/traders/top", (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 100);
    const rows = stmt.getTopTradersAll.all(limit);
    res.json({ success: true, limit, data: rows });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch top traders" });
  }
});

// Top Traders avec le plus de trades ACTIFS (state = 1)
readApp.get("/traders/top/active", (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 100);
    const rows = stmt.getTopTradersByState.all(1, limit);
    res.json({ success: true, limit, data: rows });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch top active traders" });
  }
});

// PnL et Volume total pour un trader spécifique
readApp.get("/metrics/trader/:address", (req, res) => {
  try {
    const trader = normalizeAddress(req.params.address);
    if (!trader.startsWith("0x") || trader.length < 10) {
      return res.status(400).json({ error: "Invalid address" });
    }
    const row = stmt.getTraderMetrics.get(trader);
    
    // Si le trader n'a pas de métriques, on renvoie 0
    res.json({ 
      success: true, 
      trader, 
      metrics: {
        totalPnl: row && row.totalPnl ? row.totalPnl : 0,
        totalVolume: row && row.totalVolume ? row.totalVolume : 0
      } 
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch trader metrics" });
  }
});

// Top Traders classés par Volume total
readApp.get("/metrics/top/volume", (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 100);
    const rows = stmt.getTopTradersByVolume.all(limit);
    res.json({ success: true, limit, data: rows });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch top volume traders" });
  }
});

// Top Traders classés par PnL total (les plus rentables)
readApp.get("/metrics/top/pnl", (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 100);
    const rows = stmt.getTopTradersByPnl.all(limit);
    res.json({ success: true, limit, data: rows });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch top PnL traders" });
  }
});

// Top Trades individuels classés par PnL (les trades les plus gagnants)
readApp.get("/metrics/top/trades", (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 100);
    const rows = stmt.getTopTradesByPnl.all(limit);
    res.json({ success: true, limit, data: rows });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch top trades by PnL" });
  }
});
// ---------------------------------------------------------------

// <-- AJOUT : NOUVEAU ENDPOINT POUR LIRE LES EXPOSITIONS
readApp.get("/exposures", (req, res) => {
  try {
    const memory = getAllExposures();
    res.json({
        success: true,
        count: Object.keys(memory).length,
        data: memory
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to read exposures memory" });
  }
});

// GET /trader/:address/ids?state=all|0|1|2|3
readApp.get("/trader/:address/ids", (req, res) => {
  try {
    const trader = normalizeAddress(req.params.address);
    if (!trader.startsWith("0x") || trader.length < 10) {
      return res.status(400).json({ error: "Invalid address" });
    }

    const stateQ = (req.query.state || "all").toString().toLowerCase();
    let ids;

    if (stateQ === "all") {
      ids = stmt.getTraderIdsAll.all(trader).map((r) => r.id);
    } else {
      const state = toInt(stateQ, "state");
      ids = stmt.getTraderIdsByState.all(trader, state).map((r) => r.id);
    }

    res.json({ trader, ids });
  } catch (e) {
    res.status(400).json({ error: e.message || "Bad request" });
  }
});

// GET /trade/:id
readApp.get("/trade/:id", (req, res) => {
  try {
    const id = toInt(req.params.id, "id");
    const row = stmt.getTradeById.get(id);
    if (!row) return res.status(404).json({ error: "Trade not found" });
    res.json(row);
  } catch (e) {
    res.status(400).json({ error: e.message || "Bad request" });
  }
});

// GET /match/entry?assetId=0&market=69000[&unit=human|e6]
// returns ids executable for state=0 (orders)
readApp.get("/match/entry", (req, res) => {
  try {
    const assetId = toInt(req.query.assetId, "assetId");
    const marketE6 = parseMarketE6(req.query);

    const rows = stmt.matchEntry.all(assetId, marketE6, marketE6, marketE6, marketE6);

    const out = { limit: [], stop: [] };
    for (const r of rows) {
      if (r.kind === "limit") out.limit.push(r.id);
      else if (r.kind === "stop") out.stop.push(r.id);
    }

    res.json({ assetId, marketE6, ...out });
  } catch (e) {
    res.status(400).json({ error: e.message || "Bad request" });
  }
});

// GET /match/exits?assetId=0&market=69000[&unit=human|e6]
// returns ids executable for state=1 (open positions) based on SL/TP
readApp.get("/match/exits", (req, res) => {
  try {
    const assetId = toInt(req.query.assetId, "assetId");
    const marketE6 = parseMarketE6(req.query);

    const rows = stmt.matchExits.all(
      marketE6, marketE6, marketE6, marketE6,
      assetId,
      marketE6, marketE6, marketE6, marketE6
    );

    const out = { stopLoss: [], takeProfit: [] };
    for (const r of rows) {
      if (r.kind === "stopLoss") out.stopLoss.push(r.id);
      else if (r.kind === "takeProfit") out.takeProfit.push(r.id);
    }

    res.json({ assetId, marketE6, ...out });
  } catch (e) {
    res.status(400).json({ error: e.message || "Bad request" });
  }
});

// --- LEADERBOARD COMPLET (3 LISTES TOTALEMENT DISTINCTES) ---
// GET /traders/leaderboard
readApp.get("/traders/leaderboard", (req, res) => {
  try {
    const limit = 100; // Tu veux les 100 premiers de chaque

    // On tire les 3 listes séparément avec juste leur stat dédiée
    const topByPnl = stmt.getTop100Pnl.all(limit);
    const topByVolume = stmt.getTop100Volume.all(limit);
    const topByTrades = stmt.getTop100Trades.all(limit);

    // On renvoie un JSON clair et net
    res.json({ 
      success: true, 
      topByPnl: topByPnl,       // ex: [{ trader: "0x...", pnl: 50000 }]
      topByVolume: topByVolume, // ex: [{ trader: "0x...", volume: 1500000 }]
      topByTrades: topByTrades  // ex: [{ trader: "0x...", totalTrades: 142 }]
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch leaderboards" });
  }
});

// --- RANGS ET STATS D'UN TRADER SPÉCIFIQUE ---
// GET /trader/:address/ranks
readApp.get("/trader/:address/ranks", (req, res) => {
  try {
    const trader = normalizeAddress(req.params.address);
    if (!trader.startsWith("0x") || trader.length < 10) {
      return res.status(400).json({ error: "Invalid address" });
    }

    const activityRow = stmt.getTraderRankByActivity.get(trader);
    const volumeRow = stmt.getTraderRankByVolume.get(trader);
    const pnlRow = stmt.getTraderRankByPnl.get(trader);

    res.json({
      success: true,
      trader,
      ranks: {
        activity: activityRow ? { rank: activityRow.rank, value: activityRow.tradesCount } : { rank: null, value: 0 },
        volume: volumeRow ? { rank: volumeRow.rank, value: volumeRow.totalVolume } : { rank: null, value: 0 },
        pnl: pnlRow ? { rank: pnlRow.rank, value: pnlRow.totalPnl } : { rank: null, value: 0 }
      }
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch trader ranks" });
  }
});

// ============================================================================
// --- SYSTÈME D'IMAGES DYNAMIQUE (TEST TWITTER) ---
// ============================================================================

// 1. ENDPOINT DYNAMIQUE QUI GÉNÈRE L'IMAGE (.png)
readApp.get("/trader/:address/card.png", (req, res) => {
  try {
    const address = normalizeAddress(req.params.address);
    if (!address || address.length < 10) {
      return res.status(400).send("Invalid address");
    }

    // Vérification du Cache en mémoire
    const cacheKey = `png:${address}`;
    const cachedBuffer = imageCache.get(cacheKey);
    
    if (cachedBuffer) {
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
      return res.status(200).send(cachedBuffer);
    }

    // Pas dans le cache : On lit la BDD ultra vite
    const actRow = stmt.getTraderRankByActivity.get(address);
    const volRow = stmt.getTraderRankByVolume.get(address);
    const pnlRow = stmt.getTraderRankByPnl.get(address);

    const ranks = {
      activity: { rank: actRow?.rank, value: actRow?.tradesCount || 0 },
      volume: { rank: volRow?.rank, value: volRow?.totalVolume || 0 },
      pnl: { rank: pnlRow?.rank, value: pnlRow?.totalPnl || 0 }
    };

    // On dessine avec le super design Cyberpunk
    const pngBuffer = generateTraderCard({ address, ranks });

    // On sauvegarde dans le cache pour 60 secondes
    imageCache.set(cacheKey, pngBuffer);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    res.setHeader("Content-Disposition", `inline; filename="brokex-${address}.png"`);
    
    return res.status(200).send(pngBuffer);
  } catch (err) {
    console.error("Image generation error:", err);
    res.status(500).send("Failed to generate image");
  }
});


// 2. ENDPOINT DE PARTAGE HTML (Avec les Meta-tags demandés)
readApp.get("/trader/:address/share", (req, res) => {
  try {
    const address = normalizeAddress(req.params.address);
    if (!address || address.length < 10) {
      return res.status(400).send("Invalid address");
    }

    // Le lien vers ton app et vers l'image générée à la volée
    const shareUrl = `https://brokex.trade/trader/${address}`;
    const imageUrl = `https://api.brokex.trade/trader/${address}/card.png`;

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Brokex - Trader Stats</title>

          <meta property="og:type" content="website">
          <meta property="og:url" content="${shareUrl}">
          <meta property="og:title" content="Brokex - Trader Stats">
          <meta property="og:description" content="Check out my trading performance on Brokex Protocol!">
          <meta property="og:image" content="${imageUrl}">
          
          <meta name="twitter:card" content="summary_large_image">
          <meta name="twitter:title" content="Brokex - My Trading Stats">
          <meta name="twitter:description" content="Net PnL, Volume and Ranks on-chain.">
          <meta name="twitter:image" content="${imageUrl}">
          
          <style>
            body { background: #0B0E17; color: white; font-family: sans-serif; text-align: center; padding-top: 50px; }
            img { max-width: 90%; border-radius: 16px; margin-bottom: 20px; box-shadow: 0 10px 30px rgba(0, 229, 255, 0.2); }
          </style>
      </head>
      <body>
          <img src="${imageUrl}" alt="Trader Stats" />
          <p>Redirecting to app.brokex.trade...</p>
      </body>
      </html>
    `;

    res.setHeader("Content-Type", "text/html");
    res.send(html);

  } catch (err) {
    console.error(err);
    res.status(500).send("Error generating share page");
  }
});

// Public server listens on all interfaces
readApp.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(`Public READ API: http://0.0.0.0:${PUBLIC_PORT}`);
});

// --------------------
// PRIVATE WRITE server (LOCAL ONLY)
// --------------------
const writeApp = express();

// <-- AJOUT DU MIDDLEWARE CORS POUR L'API PRIVÉE
writeApp.use(cors()); 
writeApp.use(express.json({ limit: "1mb" }));

writeApp.get("/health", (req, res) => res.json({ ok: true, mode: "private-write" }));
writeApp.use("/", writeRoutes);

// Private server listens ONLY on localhost
writeApp.listen(PRIVATE_PORT, "127.0.0.1", () => {
  console.log(`Private WRITE API (local only): http://127.0.0.1:${PRIVATE_PORT}`);
});