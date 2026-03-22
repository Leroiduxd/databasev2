#!/usr/bin/env node
/**
 * cron/sync.cron.js
 * Lance des sync périodiques (states + sltp + vérification des trous).
 * - Toutes les 10 minutes.
 */

const cron = require("node-cron");
const { spawn } = require("child_process");

function runSync(args, label) {
  return new Promise((resolve) => {
    console.log(`[cron] Starting ${label}...`);
    const p = spawn("node", ["sync.js", ...args], { stdio: "inherit" });
    p.on("close", (code) => {
      console.log(`[cron] ${label} finished with exit code=${code}`);
      resolve(code);
    });
  });
}

async function runPeriodicSync() {
  const COUNT_BIG = 10000000; // Une limite haute arbitraire, sync.js la coupera à maxExistingId
  
  console.log(`\n=== [cron] Periodic sync cycle starting @ ${new Date().toISOString()} ===`);

  // 1) Vérification et récupération des trous (missing IDs)
  await runSync(["--mode", "full", "--missing-scan", "1", String(COUNT_BIG)], "missing-scan");

  // 2) Mise à jour des states
  await runSync(["--mode", "states", "--range", "1", String(COUNT_BIG)], "states");

  // 3) Mise à jour des SL/TP
  await runSync(["--mode", "sltp", "--range", "1", String(COUNT_BIG)], "sltp");

  console.log(`=== [cron] Periodic sync cycle done @ ${new Date().toISOString()} ===\n`);
}

// Lancement initial 10 secondes après le démarrage
setTimeout(() => {
  runPeriodicSync().catch((e) => console.error("[cron] startup run error:", e));
}, 10_000);

// Lancement toutes les 10 minutes
cron.schedule("*/10 * * * *", () => {
  runPeriodicSync().catch((e) => console.error("[cron] periodic error:", e));
});

console.log("[cron] Sync cron started. Schedule: */10 * * * *");