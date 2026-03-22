#!/usr/bin/env node
/**
 * executor.multi.js
 * - Subscribe Supra WS to all PAIRS
 * - For each tick: call /match/entry, /match/exits, and /match/liquidations on your public read API
 * - Execute on CORE: executeOrder / executeStopOrTakeProfit / liquidatePosition with Supra proof snapshot
 * - Intelligent Execution Queue with 60s TTL and deduplication
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const fetch = require("node-fetch");
const http = require("http");
const { WebSocket } = require("ws");
const { ethers } = require("ethers");
const { spawn } = require("child_process");
const path = require("path");

const CORE_ABI = require("./coreAbi");

const VAULT_ABI = [
  {
    inputs: [],
    name: "lpFreeCapital",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
];

const { createProofFetcher } = require("./proofClient");
const { WalletPool } = require("./walletPool");

// --------------------
// CONFIG
// --------------------
const SUPRA_API_KEY = process.env.SUPRA_API_KEY;
const WS_URL = "wss://prod-kline-ws.supra.com";
const RESOLUTION = 1;

const DORA_RPC = process.env.DORA_RPC || "https://rpc-testnet-dora-2.supra.com";
const DORA_CHAIN = process.env.DORA_CHAIN || "evm";

const RPC_URL = process.env.RPC_URL;
const CORE_ADDRESS = process.env.CORE_ADDRESS;
const VAULT_ADDRESS = process.env.VAULT_ADDRESS; 

const READ_BASE = process.env.READ_BASE || "http://127.0.0.1:7000";

const PRIVATE_KEYS = (process.env.PRIVATE_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const LP_FREE_TTL_MS = Number(process.env.LP_FREE_TTL_MS || 1500); 
const WSS_NO_TICK_TIMEOUT_MS = Number(process.env.WSS_NO_TICK_TIMEOUT_MS || 8000);

// --------------------
// SUPRA PAIRS + MAPS
// --------------------
const PAIRS = [
  "btc_usdt", "eth_usdt", "sol_usdt", "xrp_usdt", "avax_usdt", 
  "doge_usdt", "trx_usdt", "ada_usdt", "sui_usdt", "link_usdt"
];

const PAIR_MAP = {
  0: "btc_usdt", 1: "eth_usdt", 10: "sol_usdt", 14: "xrp_usdt",
  5: "avax_usdt", 3: "doge_usdt", 15: "trx_usdt", 16: "ada_usdt",
  90: "sui_usdt", 2: "link_usdt"
};

const REVERSE_MAP = {};
for (const [idStr, pair] of Object.entries(PAIR_MAP)) {
  REVERSE_MAP[pair] = Number(idStr);
}

// --------------------
// HELPERS
// --------------------
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const SYNC_PATH = path.resolve(__dirname, "../sync.js");
const RESYNC_FLUSH_MS = Number(process.env.RESYNC_FLUSH_MS || 1000); 

function createResyncBatcher() {
  const pending = new Set();
  let timer = null;
  let inFlight = false;

  function scheduleFlush() {
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      await flush();
    }, RESYNC_FLUSH_MS);
  }

  async function flush() {
    if (inFlight) { scheduleFlush(); return; }
    if (pending.size === 0) return;

    inFlight = true;
    try {
      const ids = Array.from(pending);
      pending.clear();
      console.log(`[RESYNC-BATCH] flushing ALL ${ids.length} ids: ${ids.join(",")}`);

      await new Promise((resolve) => {
        const p = spawn("node", [SYNC_PATH, "--mode", "full", "--ids", ids.join(",")], { stdio: "inherit" });
        p.on("close", (code) => {
          console.log(`[RESYNC-BATCH] done (code=${code}) ids=${ids.length}`);
          resolve();
        });
      });
    } finally {
      inFlight = false;
      if (pending.size > 0) scheduleFlush();
    }
  }

  function enqueue(tradeId) {
    if (!Number.isFinite(tradeId) || tradeId <= 0) return;
    pending.add(Number(tradeId));
    scheduleFlush();
  }

  return { enqueue, flush };
}

async function httpGetJson(url) {
  const res = await fetch(url, { agent: httpAgent });
  const txt = await res.text();
  let data;
  try { data = txt ? JSON.parse(txt) : null; }
  catch { data = { raw: txt }; }
  if (!res.ok) throw new Error(data?.error || data?.raw || `HTTP ${res.status}`);
  return data;
}

function decimalToE6(value) {
  if (value == null) return null;
  const s0 = typeof value === "string" ? value : String(value);
  const s = s0.trim();
  if (!s) return null;

  let neg = false;
  let t = s;
  if (t.startsWith("-")) { neg = true; t = t.slice(1); }

  const parts = t.split(".");
  const intPart = parts[0] ? parts[0].replace(/^0+(?=\d)/, "") : "0";
  const fracRaw = (parts[1] || "");

  const fracPadded = (fracRaw + "0000000").slice(0, 7);
  const frac6 = fracPadded.slice(0, 6);
  const d7 = fracPadded[6] ? Number(fracPadded[6]) : 0;

  let bi = BigInt(intPart || "0") * 1000000n + BigInt(frac6 || "0");
  if (d7 >= 5) bi += 1n;

  if (neg) bi = -bi;
  return Number(bi);
}

function pickMarketFromTick(tick) {
  if (tick.currentPrice != null) return tick.currentPrice;
  if (tick.close != null) return tick.close;
  return null;
}

// --------------------
// INTELLIGENT QUEUE
// --------------------
class ExecutionQueue {
  constructor(walletPool, fetchProof, resyncBatcher, getLpFreeCapitalE6, getTradeLockedE6) {
    this.queue = [];
    this.pendingTradeIds = new Set(); 
    this.executedTradeIds = new Map(); 

    this.isProcessing = false;
    this.walletPool = walletPool;
    this.fetchProof = fetchProof;
    this.resyncBatcher = resyncBatcher;
    this.getLpFreeCapitalE6 = getLpFreeCapitalE6;
    this.getTradeLockedE6 = getTradeLockedE6;
    this.maxWaitMs = 60_000; // TTL: 60 secondes
  }

  async enqueue(task) {
    const { kind, tradeId, assetId } = task;

    // 1. Check anti-spam: Si déjà en file d'attente ou exécuté récemment, on ignore
    if (this.pendingTradeIds.has(tradeId)) return;
    const lastExecAt = this.executedTradeIds.get(tradeId);
    if (lastExecAt && Date.now() - lastExecAt < 120_000) return;

    // On verrouille le tradeId immédiatement
    this.pendingTradeIds.add(tradeId);

    try {
      // 2. Vérifications de capital pour les "entry"
      if (kind === "entry") {
        const locked = await this.getTradeLockedE6(tradeId);
        if (locked <= 0n) {
          console.log(`[SKIP] tradeId=${tradeId} locked=0 => enqueue resync`);
          this.resyncBatcher.enqueue(tradeId);
          this.pendingTradeIds.delete(tradeId);
          return; 
        }

        const free = await this.getLpFreeCapitalE6();
        if (free < locked) {
          console.log(`[SKIP] Not enough LP free capital. tradeId=${tradeId} locked=${locked} free=${free}`);
          this.pendingTradeIds.delete(tradeId);
          return; 
        }
      }

      // 3. SNAPSHOT DE LA PREUVE: On fige la preuve Supra liée à cet instant précis
      task.proof = await this.fetchProof([assetId]);
      task.addedAt = Date.now();
      
      this.queue.push(task);
      this.processQueue(); 

    } catch (err) {
      console.error(`[QUEUE ERR] Setup failed for tradeId=${tradeId}`, err.message);
      this.pendingTradeIds.delete(tradeId);
    }
  }

  async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift();
      this.pendingTradeIds.delete(task.tradeId);

      // 4. Vérification TTL (60s). Si périmé => on jette silencieusement.
      const waitTime = Date.now() - task.addedAt;
      if (waitTime > this.maxWaitMs) {
        console.log(`[DROP] Preuve périmée dans la file (${waitTime}ms) - tradeId=${task.tradeId}`);
        continue; 
      }

      try {
        // Attente intelligente d'un wallet disponible
        const wallet = await this.walletPool.acquire();

        // On marque le trade comme "traité" pour bloquer les prochains ticks WS pendant 2 minutes
        this.executedTradeIds.set(task.tradeId, Date.now());

        // Lancement en arrière-plan
        this.executeOnChain(task, wallet).catch(e => {
          console.error(`[EXEC ERR] ${task.kind} tradeId=${task.tradeId}`, e.reason || e.message);
          this.resyncBatcher.enqueue(task.tradeId);
          // Si fail réseau/revert, on le supprime de l'historique pour autoriser une repasse
          this.executedTradeIds.delete(task.tradeId); 
        });

      } catch (err) {
        console.error("[PROCESS QUEUE ERR]", err);
      }
    }

    this.isProcessing = false;
    this.cleanUpMemory(); 
  }

  async executeOnChain(task, wallet) {
    const core = new ethers.Contract(CORE_ADDRESS, CORE_ABI, wallet);
    const proof = task.proof; // Utilisation de la preuve figée

    let tx;
    if (task.kind === "entry") {
      tx = await core.executeOrder(task.tradeId, proof);
    } else if (task.kind === "exit") {
      tx = await core.executeStopOrTakeProfit(task.tradeId, proof);
    } else if (task.kind === "liquidation") {
      tx = await core.liquidatePosition(task.tradeId, proof);
    }

    console.log(`[TX SENT] ${task.kind} tradeId=${task.tradeId} via ${wallet.address} | hash: ${tx.hash}`);
    await tx.wait(1);
    console.log(`[TX MINED] ${task.kind} tradeId=${task.tradeId}`);
  }

  cleanUpMemory() {
    const now = Date.now();
    for (const [id, ts] of this.executedTradeIds.entries()) {
      if (now - ts > 120_000) { // Nettoyage après 2 minutes
        this.executedTradeIds.delete(id);
      }
    }
  }
}

// --------------------
// MAIN
// --------------------
async function main() {
  if (!SUPRA_API_KEY) throw new Error("Missing SUPRA_API_KEY");
  if (!RPC_URL) throw new Error("Missing RPC_URL");
  if (!CORE_ADDRESS) throw new Error("Missing CORE_ADDRESS");
  if (!VAULT_ADDRESS) throw new Error("Missing VAULT_ADDRESS");
  if (!PRIVATE_KEYS.length) throw new Error("Missing PRIVATE_KEYS");
  if (!READ_BASE) throw new Error("Missing READ_BASE");

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, provider);

  const walletPool = new WalletPool({
    provider,
    privateKeys: PRIVATE_KEYS,
    perWalletDelayMs: 3000, // 3 secondes recommandées pour éviter les soucis de nonces
  });

  const fetchProof = createProofFetcher({ doraRpc: DORA_RPC, chainType: DORA_CHAIN });
  const resyncBatcher = createResyncBatcher();

  let lpFreeCache = { ts: 0, valueE6: 0n };
  async function getLpFreeCapitalE6() {
    const now = Date.now();
    if (now - lpFreeCache.ts < LP_FREE_TTL_MS) return lpFreeCache.valueE6;
    const v = await vault.lpFreeCapital();
    const bi = BigInt(v.toString());
    lpFreeCache = { ts: now, valueE6: bi };
    return bi;
  }

  const lockedCache = new Map();
  async function getTradeLockedE6(tradeId) {
    const hit = lockedCache.get(tradeId);
    if (hit !== undefined) return hit;
    const t = await httpGetJson(`${READ_BASE}/trade/${tradeId}`);
    const locked = BigInt(String(t.lpLockedCapital ?? "0"));
    lockedCache.set(tradeId, locked);
    return locked;
  }

  // Initialisation de la file d'attente
  const execQueue = new ExecutionQueue(
    walletPool, fetchProof, resyncBatcher, getLpFreeCapitalE6, getTradeLockedE6
  );

  function connectSupra() {
    console.log("[Executor] Connecting Supra WS:", WS_URL);
    let closedByUs = false;
    let lastTickAt = Date.now();
    let watchdog = null;

    function startWatchdog(ws) {
      if (watchdog) clearInterval(watchdog);
      watchdog = setInterval(() => {
        const now = Date.now();
        if (now - lastTickAt > WSS_NO_TICK_TIMEOUT_MS) {
          console.error(`[Executor] No ticks for ${now - lastTickAt}ms. Reconnecting...`);
          closedByUs = true;
          try { ws.terminate(); } catch {}
        }
      }, 1000);
    }

    const ws = new WebSocket(WS_URL, { headers: { "x-api-key": SUPRA_API_KEY } });

    ws.on("open", () => {
      console.log("[Executor] Supra connected, subscribing to", PAIRS.length, "pairs…");
      lastTickAt = Date.now();
      startWatchdog(ws);

      ws.send(JSON.stringify({
        action: "subscribe",
        channels: [{ name: "ohlc_datafeed", resolution: RESOLUTION, tradingPairs: PAIRS }],
      }));
    });

    ws.on("message", async (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (msg.event !== "ohlc_datafeed" || !Array.isArray(msg.payload)) return;

      lastTickAt = Date.now();

      for (const tick of msg.payload) {
        const pair = tick.tradingPair;
        if (!pair) continue;
        const assetId = REVERSE_MAP[pair];
        if (assetId === undefined) continue;

        const marketRaw = pickMarketFromTick(tick);
        const marketE6 = decimalToE6(marketRaw);
        if (marketE6 === null) continue;

        console.log(`[TICK] ${pair.toUpperCase()} : ${marketRaw} (AssetID: ${assetId})`);

        try {
          const entry = await httpGetJson(`${READ_BASE}/match/entry?assetId=${assetId}&market=${marketE6}&unit=e6`);
          const exits = await httpGetJson(`${READ_BASE}/match/exits?assetId=${assetId}&market=${marketE6}&unit=e6`);
          const liqs = await httpGetJson(`${READ_BASE}/match/liquidations?assetId=${assetId}&market=${marketE6}&unit=e6`);

          const entryIds = [...(entry.limit || []), ...(entry.stop || [])];
          const exitIds = [...(exits.stopLoss || []), ...(exits.takeProfit || [])];
          const liqIds = liqs.liquidations || [];

          // PLUS DE AWAIT NI DE SLEEP : On balance tout dans la file
          for (const id of entryIds) execQueue.enqueue({ kind: "entry", tradeId: id, assetId });
          for (const id of exitIds) execQueue.enqueue({ kind: "exit", tradeId: id, assetId });
          for (const id of liqIds) execQueue.enqueue({ kind: "liquidation", tradeId: id, assetId });

        } catch (e) {
          console.error("[Executor] match API error:", pair, "assetId=", assetId, e.message);
        }
      }
    });

    ws.on("close", () => {
      if (watchdog) clearInterval(watchdog);
      console.error("[Executor] Supra WS closed.", closedByUs ? "(forced reconnect)" : "");
      console.error("[Executor] Reconnecting in 3s…");
      setTimeout(connectSupra, 3000);
    });

    ws.on("error", (err) => console.error("[Executor] Supra WS error:", err.message || err));
  }

  console.log("[Executor] READY");
  console.log(" - CORE:", CORE_ADDRESS);
  console.log(" - wallets:", PRIVATE_KEYS.length);
  connectSupra();
}

main().catch((e) => { console.error("executor fatal:", e); process.exit(1); });