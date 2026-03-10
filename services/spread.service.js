// services/spread.service.js
require("dotenv").config();
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL;
const CORE_ADDRESS = process.env.CORE_ADDRESS;

if (!RPC_URL || !CORE_ADDRESS) {
    console.error("❌ [Spread] Erreur: RPC_URL ou CORE_ADDRESS manquant.");
}

// L'ABI exact basé sur la fonction "assets" de ton contrat
const ABI = [
    "function assets(uint32) view returns (uint32 assetId, uint32 numerator, uint32 denominator, uint64 baseFundingRate, uint64 spread, uint32 commission, uint64 weekendFunding, uint16 securityMultiplier, uint16 maxPhysicalMove, uint8 maxLeverage, uint32 maxLongLots, uint32 maxShortLots, uint32 maxOracleDelay, bool allowOpen, bool listed)"
];

// Attention : on utilise bien ethers.providers pour la version 5 d'ethers
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const coreContract = new ethers.Contract(CORE_ADDRESS, ABI, provider);

// CACHE EN MÉMOIRE
const baseSpreads = {}; 

// Liste de tes actifs (sans le Forex)
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
            
            // assetData[4] correspond exactement à "uint64 spread" d'après ton ABI
            // On le convertit en String pour éviter les soucis de BigInt dans les JSON
            baseSpreads[assetId] = assetData[4].toString(); 
            
        } catch (e) {
            console.error(`[Spread] Erreur init asset ${assetId}:`, e.message);
        }
    }
    console.log("[Spread] ✅ Base Spreads récupérés !");
}

// Fonction pour renvoyer tous les spreads d'un coup à ton API
function getAllBaseSpreads() {
    return baseSpreads;
}

module.exports = { initBaseSpreads, getAllBaseSpreads };