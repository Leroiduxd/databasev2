// services/funding.service.js
require("dotenv").config();
const { ethers } = require("ethers");

// Configuration via les variables d'environnement
const RPC_URL = process.env.RPC_URL;
const CORE_ADDRESS = process.env.CORE_ADDRESS;

if (!RPC_URL || !CORE_ADDRESS) {
    console.error("❌ [Funding] Erreur: RPC_URL ou CORE_ADDRESS manquant dans le .env");
}

// L'ABI minimal pour lire les infos de funding
const ABI = [
    "function assets(uint32) view returns (uint32,uint32,uint32,uint64 baseFundingRate,uint64,uint32,uint64,uint16,uint16,uint8,uint32,uint32,uint32,bool,bool)",
    "function exposures(uint32) view returns (int32 longLots, int32 shortLots, uint128, uint128, uint128, uint128, uint128, uint128)",
    "function fundingStates(uint32) view returns (uint64 lastUpdate, uint128 longFundingIndex, uint128 shortFundingIndex)"
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const coreContract = new ethers.Contract(CORE_ADDRESS, ABI, provider);

// CACHE EN MÉMOIRE
const baseRates = {}; // Stocké UNE SEULE FOIS au lancement
const fundingCache = {}; // Mis à jour à chaque trade

// Liste des actifs (sans le Forex)
const ACTIVE_ASSETS = [
    0, 1, 2, 3, 5, 10, 14, 15, 16, 90, // Crypto
    5500, 5501, // Métaux (XAU, XAG)
    6000, 6001, 6002, 6003, 6004, 6005, 6006, 6009, 6010, 6011, // Actions Tech
    6034, 6059, 6066, 6068, // Autres Actions
    6113, 6114, 6115 // ETFs
];

// 1. La formule mathématique exacte de ton contrat (pour calculer le nouveau Rate horaire)
function computeFundingRateQuadratic(longLots, shortLots, baseFundingWad) {
    const L = BigInt(longLots > 0 ? longLots : 0);
    const S = BigInt(shortLots > 0 ? shortLots : 0);
    const baseFunding = BigInt(baseFundingWad);
    const WAD = 1000000000000000000n; // 1e18

    if (L === S) return { longRate: baseFunding, shortRate: baseFunding };

    const numerator = L > S ? (L - S) : (S - L);
    const denominator = L + S + 2n;
    const r = (numerator * WAD) / denominator;
    const p = (r * r) / WAD;
    const dominantRate = (baseFunding * (WAD + 3n * p)) / WAD;

    if (L > S) return { longRate: dominantRate, shortRate: baseFunding };
    else return { longRate: baseFunding, shortRate: dominantRate };
}

// 2. Initialisation au lancement (Appelé 1 seule fois dans ton serveur.js)
async function initBaseFunding() {
    console.log(`[Funding] Initialisation des Base Rates pour ${ACTIVE_ASSETS.length} actifs...`);
    
    for (const assetId of ACTIVE_ASSETS) {
        try {
            const assetData = await coreContract.assets(assetId);
            // Index 3 correspond au uint64 baseFundingRate dans ton ABI
            baseRates[assetId] = BigInt(assetData[3]); 
            
            // On initialise le cache direct
            await updateFundingForAsset(assetId); 
        } catch (e) {
            console.error(`[Funding] Erreur init asset ${assetId}:`, e.message);
        }
    }
    console.log("[Funding] ✅ Initialisation terminée !");
}

// 3. Mise à jour (Appelé par db.js à chaque nouveau trade/fermeture)
async function updateFundingForAsset(assetId) {
    // Si l'actif n'est pas tracké (ex: forex), on l'ignore
    if (baseRates[assetId] === undefined) return;

    try {
        // On récupère les VRAIS index arrêtés par le smart contract et la NOUVELLE exposition
        const [state, exposure] = await Promise.all([
            coreContract.fundingStates(assetId),
            coreContract.exposures(assetId)
        ]);

        // On calcule le NOUVEAU taux horaire basé sur la NOUVELLE exposition
        const rates = computeFundingRateQuadratic(
            exposure.longLots,
            exposure.shortLots,
            baseRates[assetId]
        );

        // On stocke la nouvelle base de départ pour nos projections futures
        fundingCache[assetId] = {
            lastUpdate: Number(state.lastUpdate),
            longIdx: BigInt(state.longFundingIndex),
            shortIdx: BigInt(state.shortFundingIndex),
            longRateHourly: rates.longRate,
            shortRateHourly: rates.shortRate
        };
        // console.log(`[Funding] Asset ${assetId} mis à jour (Nouveaux taux calculés)`);
    } catch (e) {
        console.error(`[Funding] Erreur update asset ${assetId}:`, e.message);
    }
}

// 4. Lecture instantanée pour l'API (Zéro appel RPC)
function getLiveFunding(assetId) {
    const data = fundingCache[assetId];
    if (!data) return null;

    const currentTimestamp = Math.floor(Date.now() / 1000);
    let liveLongIdx = data.longIdx;
    let liveShortIdx = data.shortIdx;

    if (currentTimestamp > data.lastUpdate && data.lastUpdate !== 0) {
        const timePassed = BigInt(currentTimestamp - data.lastUpdate);
        
        // Formule linéaire stricte: Index + (Rate * time / 3600)
        liveLongIdx += (data.longRateHourly * timePassed) / 3600n;
        liveShortIdx += (data.shortRateHourly * timePassed) / 3600n;
    }

    // On convertit les BigInt en String pour que le JSON.stringify marche sans erreur
    return {
        assetId,
        liveLongIndex: liveLongIdx.toString(),
        liveShortIndex: liveShortIdx.toString(),
        currentLongRateHourly: data.longRateHourly.toString(),
        currentShortRateHourly: data.shortRateHourly.toString(),
        lastUpdate: data.lastUpdate,
        timestamp: currentTimestamp
    };
}

module.exports = { 
    initBaseFunding, 
    updateFundingForAsset, 
    getLiveFunding,
    ACTIVE_ASSETS 
};