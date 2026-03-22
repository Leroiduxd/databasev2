#!/usr/bin/env node
/**
 * sync.js
 *
 * Modes:
 * - full   : fetch full trades via getTradesFromList + écriture directe DB (batch)
 * - states : fetch states via getTradeStatesFromList. Si le state diffère, déclenche un "full" sync.
 *
 * Logic:
 * - Always read nextTradeID() from CORE to know max existing id onchain
 * - If id <= maxExistingId but missing in DB => full fetch
 *
 * Usage examples:
 * node sync.js --mode full --catchup        <-- BOUCHE LES TROUS AUTOMATIQUEMENT
 * node sync.js --mode states --range 1 5000
 * node sync.js --mode full --ids 14,15
 */

const pLimit = require("p-limit");
const cfg = require("./config");
const { db, stmt } = require("./db"); // <-- IMPORT DIRECT DE LA DB

const ethersPkg = require("ethers");
const ethers = ethersPkg.ethers ?? ethersPkg;

// --------------------
// Tunables
// --------------------
const BATCH_SIZE = 50;
const RPC_CONCURRENCY = 20;

// Utilitaire pour l'attente (1 seconde)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --------------------
// Minimal ABIs
// --------------------
const CORE_ABI = [
  {
    inputs: [],
    name: "nextTradeID",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
];

const PAYMASTER_ABI = [
  {
    inputs: [{ internalType: "uint256[]", name: "tradeIds", type: "uint256[]" }],
    name: "getTradeStatesFromList",
    outputs: [{ internalType: "uint8[]", name: "states", type: "uint8[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256[]", name: "tradeIds", type: "uint256[]" }],
    name: "getTradesFromList",
    outputs: [
      {
        components: [
          { internalType: "address", name: "trader", type: "address" },
          { internalType: "uint32", name: "assetId", type: "uint32" },
          { internalType: "bool", name: "isLong", type: "bool" },
          { internalType: "bool", name: "isLimit", type: "bool" },
          { internalType: "uint8", name: "leverage", type: "uint8" },
          { internalType: "uint48", name: "openPrice", type: "uint48" },
          { internalType: "uint8", name: "state", type: "uint8" },
          { internalType: "uint32", name: "openTimestamp", type: "uint32" },
          { internalType: "uint32", name: "closeTimestamp", type: "uint32" },
          { internalType: "uint128", name: "fundingIndex", type: "uint128" },
          { internalType: "uint48", name: "closePrice", type: "uint48" },
          { internalType: "int32", name: "lotSize", type: "int32" },
          { internalType: "int32", name: "closedLotSize", type: "int32" },
          { internalType: "uint48", name: "stopLoss", type: "uint48" },
          { internalType: "uint48", name: "takeProfit", type: "uint48" },
          { internalType: "uint64", name: "lpLockedCapital", type: "uint64" },
          { internalType: "uint64", name: "marginUsdc", type: "uint64" },
          { internalType: "uint64", name: "totalFeesPaidUsdc", type: "uint64" }
        ],
        internalType: "struct IBrokexCore.Trade[]",
        name: "fetchedTrades",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  }
];

// --------------------
// Helpers
// --------------------
function parseArgs(argv) {
  const out = { mode: null, ids: null, range: null, missingScan: null, catchup: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") out.mode = argv[++i];
    else if (a === "--ids") out.ids = argv[++i];
    else if (a === "--range") out.range = [Number(argv[++i]), Number(argv[++i])];
    else if (a === "--missing-scan") out.missingScan = [Number(argv[++i]), Number(argv[++i])];
    else if (a === "--catchup") out.catchup = true;
  }
  return out;
}

function chunk(arr, size) {
  const res = [];
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
  return res;
}

function toIntSafeBN(x) {
  if (typeof x === "bigint") return x;
  if (x && typeof x.toString === "function") return BigInt(x.toString());
  return BigInt(x);
}

function normalizeAddr(a) {
  return String(a).toLowerCase();
}

// --------------------
// DB Transactions (Fast direct write)
// --------------------
const batchUpsertDB = db.transaction((payloads) => {
  for (const p of payloads) {
    stmt.upsertTrade.run(p);
  }
  return payloads.length;
});

// --------------------
// Mapping onchain trade -> DB payload
// --------------------
function tradeToPayload(id, t) {
  return {
    id: Number(id),
    trader: normalizeAddr(t.trader),
    assetId: Number(t.assetId),
    isLong: t.isLong ? 1 : 0,
    isLimit: t.isLimit ? 1 : 0,
    leverage: t.leverage == null ? null : Number(t.leverage),

    openPrice: t.openPrice == null ? null : Number(t.openPrice),
    state: Number(t.state),
    openTimestamp: t.openTimestamp == null ? null : Number(t.openTimestamp),
    closeTimestamp: t.closeTimestamp == null ? null : Number(t.closeTimestamp),
    fundingIndex: t.fundingIndex == null ? null : String(t.fundingIndex),

    closePrice: t.closePrice ? Number(t.closePrice) : 0,
    lotSize: t.lotSize == null ? null : Number(t.lotSize),
    closedLotSize: t.closedLotSize ? Number(t.closedLotSize) : 0,

    stopLoss: t.stopLoss ? Number(t.stopLoss) : 0,
    takeProfit: t.takeProfit ? Number(t.takeProfit) : 0,

    lpLockedCapital: t.lpLockedCapital == null ? null : String(t.lpLockedCapital),
    marginUsdc: t.marginUsdc == null ? null : String(t.marginUsdc),
    totalFeesPaidUsdc: t.totalFeesPaidUsdc == null ? null : String(t.totalFeesPaidUsdc),
  };
}

// --------------------
// Core sync actions
// --------------------
async function syncFull({ paymaster, ids }) {
  if (ids.length === 0) return { upserted: 0 };

  console.log(`⏳ Attente 1 sec avant requête RPC pour ${ids.length} trade(s)...`);
  await sleep(1000); // <-- LE DÉLAI EST ICI

  const trades = await paymaster.getTradesFromList(ids);
  const payloads = ids.map((id, i) => tradeToPayload(id, trades[i]));

  // ÉCRITURE DIRECTE EN BASE
  const upsertedCount = batchUpsertDB(payloads);

  return { upserted: upsertedCount };
}

async function syncStates({ paymaster, ids, maxExistingId }) {
  const missing = [];
  const present = [];

  for (const id of ids) {
    if (id > maxExistingId) continue;
    
    // LECTURE DIRECTE EN BASE
    const row = stmt.getTradeById.get(id);
    if (!row) {
      missing.push(id);
    } else {
      present.push({ id, dbState: Number(row.state) });
    }
  }

  const needFull = [...missing]; 

  if (present.length > 0) {
    console.log(`⏳ Attente 1 sec avant vérification des états...`);
    await sleep(1000); // <-- LE DÉLAI EST ICI AUSSI

    const queryIds = present.map(p => p.id);
    const states = await paymaster.getTradeStatesFromList(queryIds);
    
    for (let i = 0; i < present.length; i++) {
      const { id, dbState } = present[i];
      const newState = Number(states[i]);
      
      if (dbState !== newState) {
        needFull.push(id);
      }
    }
  }

  let upserted = 0;
  if (needFull.length > 0) {
    const r = await syncFull({ paymaster, ids: needFull });
    upserted = r.upserted;
  }

  return { upsertedMissingOrChanged: upserted };
}

// --------------------
// MAIN
// --------------------
async function main() {
  const args = parseArgs(process.argv);
  const mode = args.mode;

  if (!["full", "states"].includes(mode)) {
    console.error("Usage: node sync.js --mode full|states [--ids 1,2,3 | --range 1 50 | --catchup]");
    process.exit(1);
  }

  const provider = ethers.JsonRpcProvider
    ? new ethers.JsonRpcProvider(cfg.RPC_URL)
    : new ethers.providers.JsonRpcProvider(cfg.RPC_URL);
  
  const core = new ethers.Contract(cfg.CORE_ADDRESS, CORE_ABI, provider);
  const paymaster = new ethers.Contract(cfg.PAYMASTER_ADDRESS, PAYMASTER_ABI, provider);

  // CORRECTION: On enlève le "- 1" pour avoir le vrai max ID
  const nextId = toIntSafeBN(await core.nextTradeID());
  const maxExistingId = Number(nextId); 

  if (maxExistingId <= 0) {
    console.log("No trades onchain yet. Nothing to sync.");
    process.exit(0);
  }
  
  let ids = [];

  if (args.ids) {
    ids = args.ids.split(",").map(Number).filter(n => Number.isFinite(n) && n >= 1);
  } else if (args.range) {
    let [start, count] = args.range;
    start = Math.max(1, start);
    for (let i = 0; i < count; i++) ids.push(start + i);
  } else if (args.catchup) {
    // --- NOUVEAU : On cherche tous les trous de 1 à maxExistingId
    for (let id = 1; id <= maxExistingId; id++) {
      if (!stmt.getTradeById.get(id)) {
        ids.push(id);
      }
    }
    console.log(`[CATCHUP] Scan terminé. ${ids.length} trade(s) manquant(s) trouvé(s) sur ${maxExistingId} maximum.`);
    if (ids.length === 0) {
      console.log("La base de données est déjà à jour !");
      process.exit(0);
    }
  } else if (args.missingScan) {
    const [start, end] = args.missingScan;
    const realStart = Math.max(1, start);
    const realEnd = Math.min(end, maxExistingId);
    
    for (let id = realStart; id <= realEnd; id++) {
      if (!stmt.getTradeById.get(id)) ids.push(id);
    }
    console.log(`Missing in DB within [${realStart}..${realEnd}]: ${ids.length}`);
  } else {
    console.error("Provide --ids, --range, --catchup or --missing-scan");
    process.exit(1);
  }

  // Sécurité: on ne bloque pas si l'utilisateur a tapé des IDs manuellement ou via le listener
  if (!args.ids) {
    ids = ids.filter((id) => id >= 1 && id <= maxExistingId);
  }
  
  const limit = pLimit(RPC_CONCURRENCY);
  const batches = chunk(ids, BATCH_SIZE);
  let totals = { upserted: 0 };

  const tasks = batches.map((b, idx) =>
    limit(async () => {
      if (!b.length) return;

      if (mode === "full") {
        const r = await syncFull({ paymaster, ids: b });
        totals.upserted += r.upserted;
      } else if (mode === "states") {
        const r = await syncStates({ paymaster, ids: b, maxExistingId });
        totals.upserted += r.upsertedMissingOrChanged;
      }

      if ((idx + 1) % 10 === 0 || idx === batches.length - 1) {
        console.log(`[${mode}] batches ${idx + 1}/${batches.length} done`);
      }
    })
  );

  try {
    await Promise.all(tasks);
  } finally {
    db.close();
  }

  console.log("Done.", { mode, maxExistingId, ...totals });
}

main().catch((e) => {
  console.error("sync.js error:", e);
  process.exit(1);
});