// services/spread.service.js
require("dotenv").config();
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL;
const CORE_ADDRESS = process.env.CORE_ADDRESS;

const ABI = [
    "function assets(uint32) view returns (uint32,uint32,uint32,uint64 baseFundingRate,uint64 spread,uint32,uint64,uint16,uint16,uint8,uint32,uint32,uint32,bool,bool)"
];

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const coreContract = new ethers.Contract(CORE_ADDRESS, ABI, provider);

// CACHE EN MÉMOIRE
const baseSpreads = {}; 

const ACTIVE_ASSETS = [
    0, 1, 2, 3, 5, 10, 14, 15, 16, 90, // Crypto
    5500, 5501, // Métaux
    6000, 6001, 6002, 6003, 6004, 6005, 6006, 6009, 6010, 6011, // Actions
    6034, 6059, 6066, 6068, 6113, 6114, 6115 // ETFs
];

// Initialisation au lancement (Appelé 1 seule fois)
async function initBaseSpreads() {
    console.log(`[Spread] Récupération des Base Spreads pour ${ACTIVE_ASSETS.length} actifs...`);
    for (const assetId of ACTIVE_ASSETS) {
        try {
            const assetData = await coreContract.assets(assetId);
            // On stocke le spread en String (ex: "1000000000000000") pour le JSON
            baseSpreads[assetId] = assetData[4].toString(); 
        } catch (e) {
            console.error(`[Spread] Erreur init asset ${assetId}:`, e.message);
        }
    }
    console.log("[Spread] ✅ Base Spreads récupérés !");
}

// Fonction pour renvoyer tous les spreads d'un coup
function getAllBaseSpreads() {
    return baseSpreads;
}

module.exports = { initBaseSpreads, getAllBaseSpreads };