// executor/proofClient.js (CommonJS)
const fetch = require("node-fetch");

class PullServiceClient {
  constructor(address) {
    this.address = String(address).replace(/\/+$/, "");
    this.timeoutMs = 12_000;
  }

  async _post(url, body) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} @ ${url} :: ${text.slice(0, 200)}`);
      }
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  async getProof({ pair_indexes, chain_type }) {
    if (!Array.isArray(pair_indexes) || pair_indexes.length === 0) {
      throw new Error("pair_indexes must be a non-empty array");
    }
    const chain = chain_type || "evm";

    const endpoints = [
      {
        url: `${this.address}`,
        body: { id: 1, jsonrpc: "2.0", method: "get_proof", params: { pair_indexes, chain_type: chain } },
        pick: (j) => j?.result?.proof_bytes || j?.result?.proofBytes || j?.proof_bytes || j?.proofBytes,
      },
      {
        url: `${this.address}/rpc`,
        body: { id: 1, jsonrpc: "2.0", method: "get_proof", params: { pair_indexes, chain_type: chain } },
        pick: (j) => j?.result?.proof_bytes || j?.result?.proofBytes || j?.proof_bytes || j?.proofBytes,
      },
      {
        url: `${this.address}/v2/pull/get_proof`,
        body: { pair_indexes, chain_type: chain },
        pick: (j) => j?.proof_bytes || j?.proofBytes || j?.data?.proof_bytes || j?.data?.proofBytes,
      },
      {
        url: `${this.address}/pull-service/get_proof`,
        body: { pair_indexes, chain_type: chain },
        pick: (j) => j?.proof_bytes || j?.proofBytes || j?.data?.proof_bytes || j?.data?.proofBytes,
      },
      {
        url: `${this.address}/get_proof`,
        body: { pair_indexes, chain_type: chain },
        pick: (j) => j?.proof_bytes || j?.proofBytes || j?.data?.proof_bytes || j?.data?.proofBytes,
      },
    ];

    let lastErr;
    for (const cand of endpoints) {
      try {
        const json = await this._post(cand.url, cand.body);
        const proof = cand.pick(json) || json?.data?.proof_bytes;
        if (proof) return { proof_bytes: String(proof) };
        lastErr = new Error(`No proof_bytes in response from ${cand.url}`);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("Unable to fetch proof");
  }
}

// --- LOGIQUE DE CACHE ANTI-STAMPEDE ---

// Durée pendant laquelle on réutilise la même requête (1 seconde)
const CACHE_TTL_MS = 1000; 
const cache = new Map(); // Map de clés (paires) vers { proofPromise, ts }

function makeKey(pairs) {
  return [...pairs].sort((a, b) => a - b).join(",");
}

function normalizeProof(p) {
  const s = String(p);
  return s.startsWith("0x") ? s : "0x" + s;
}

function createProofFetcher({ doraRpc, chainType }) {
  const client = new PullServiceClient(doraRpc);

  return async function fetchProof(pairIndexes) {
    const key = makeKey(pairIndexes);
    const now = Date.now();
    const hit = cache.get(key);

    // Si une requête a été lancée il y a moins d'une seconde, 
    // on retourne sa Promesse (qu'elle soit en cours ou terminée).
    if (hit && now - hit.ts < CACHE_TTL_MS) {
      return hit.proofPromise;
    }

    // Sinon, on lance la vraie requête API
    const fetchPromise = client.getProof({ pair_indexes: pairIndexes, chain_type: chainType })
      .then(data => normalizeProof(data.proof_bytes))
      .catch(err => {
        // En cas d'erreur de Supra, on "nettoie" le cache pour permettre 
        // aux appels suivants de réessayer tout de suite.
        cache.delete(key);
        throw err;
      });

    // On sauvegarde la Promesse dans le cache AVANT de faire "await"
    cache.set(key, { proofPromise: fetchPromise, ts: now });

    // On retourne la promesse, l'appelant fera "await fetchProof(...)"
    return fetchPromise;
  };
}

module.exports = { createProofFetcher };