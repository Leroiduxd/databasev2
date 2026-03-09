// services/image.service.js
const { createCanvas } = require("@napi-rs/canvas");

const WIDTH = 1200;
const HEIGHT = 630;

function shortAddr(addr) {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function formatCompactUSD(num) {
  if (num === null || num === undefined || Number.isNaN(Number(num))) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2,
  }).format(num);
}

function formatUSD(num) {
  if (num === null || num === undefined || Number.isNaN(Number(num))) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 2,
  }).format(num);
}

function fromE6(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return null;
  return Number(v) / 1_000_000;
}

function drawMetricCard(ctx, { x, y, w, h, title, value, subtitleLeft, subtitleRight, isBlueValue }) {
  // Fond de la carte (Très sombre, angle droit)
  ctx.fillStyle = "rgba(10, 15, 25, 0.9)";
  ctx.fillRect(x, y, w, h);
  
  // Bordure subtile bleutée
  ctx.strokeStyle = "rgba(45, 136, 255, 0.25)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);

  // Petit Triangle d'accentuation Bleu en haut à gauche (Design Cyberpunk)
  ctx.fillStyle = "#2D88FF";
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 35, y);
  ctx.lineTo(x, y + 35);
  ctx.closePath();
  ctx.fill();

  // Ligne accentuée bleue en haut
  ctx.fillRect(x, y, w, 3);

  // Titre de la carte
  ctx.fillStyle = "rgba(255,255,255,0.50)";
  ctx.font = "bold 18px sans-serif";
  ctx.fillText(title.toUpperCase(), x + 30, y + 55);

  // Valeur Centrale (Énorme police)
  ctx.fillStyle = isBlueValue ? "#2D88FF" : "#FFFFFF"; // Bleu pour le PNL, Blanc pour le reste
  ctx.font = "bold 46px sans-serif";
  
  let displayValue = value;
  if (ctx.measureText(displayValue).width > w - 60) {
     ctx.font = "bold 34px sans-serif"; // Réduit si le nombre est gigantesque
  }
  ctx.fillText(displayValue, x + 30, y + 115);

  // Séparateur interne
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(x + 30, y + 155, w - 60, 1);

  // Sous-titres (Rangs)
  ctx.fillStyle = "rgba(255,255,255,0.40)";
  ctx.font = "bold 16px sans-serif";
  ctx.fillText(subtitleLeft, x + 30, y + 190);

  ctx.fillStyle = "rgba(255,255,255,0.90)";
  ctx.font = "bold 18px sans-serif";
  const textW = ctx.measureText(subtitleRight).width;
  ctx.fillText(subtitleRight, x + w - 30 - textW, y + 190);
}

function generateTraderCard({ address, ranks }) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  // Fond global ultra sombre (Noir bleuté profond)
  ctx.fillStyle = "#03060C";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Halo lumineux bleu très léger en haut à gauche
  const glowLeft = ctx.createRadialGradient(0, 0, 0, 0, 0, 1000);
  glowLeft.addColorStop(0, "rgba(45, 136, 255, 0.12)"); 
  glowLeft.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = glowLeft;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // TITRE : BROKEX PROTOCOL (Énorme)
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 58px sans-serif";
  ctx.fillText("BROKEX", 72, 110);

  ctx.fillStyle = "#2D88FF";
  ctx.fillText("PROTOCOL", 72 + ctx.measureText("BROKEX ").width, 110);

  ctx.fillStyle = "rgba(255,255,255,0.60)";
  ctx.font = "bold 24px sans-serif";
  ctx.fillText("ON-CHAIN PERFORMANCE", 72, 150);

  // Tag "Powered by Pharos" (Angles droits)
  ctx.fillStyle = "rgba(10, 15, 25, 0.8)";
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  ctx.fillRect(WIDTH - 250, 70, 178, 48);
  ctx.strokeRect(WIDTH - 250, 70, 178, 48);

  ctx.fillStyle = "rgba(255,255,255,0.90)";
  ctx.font = "bold 16px sans-serif";
  ctx.fillText("Powered by Pharos", WIDTH - 235, 100);

  // BOX ADRESSE (Plus grande, angles droits)
  ctx.fillStyle = "rgba(10, 15, 25, 0.8)";
  ctx.strokeStyle = "rgba(45, 136, 255, 0.25)";
  ctx.fillRect(72, 195, WIDTH - 144, 85);
  ctx.strokeRect(72, 195, WIDTH - 144, 85);

  // Point Bleu Néon
  ctx.fillStyle = "#2D88FF";
  ctx.beginPath();
  ctx.arc(104, 225, 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.50)";
  ctx.font = "bold 18px sans-serif";
  ctx.fillText("Trader Wallet", 124, 230);

  // Adresse en plus gros
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 28px sans-serif";
  ctx.fillText(address, 124, 260);

  // EXTRACTION DES DONNÉES
  const activityRank = ranks?.activity?.rank ?? null;
  const totalTrades = ranks?.activity?.value ?? null;
  const volumeRank = ranks?.volume?.rank ?? null;
  const volumeUsd = fromE6(ranks?.volume?.value);
  const pnlRank = ranks?.pnl?.rank ?? null;
  const pnlUsd = fromE6(ranks?.pnl?.value);

  // LAYOUT DES CARTES
  const cardY = 320;
  const gap = 24;
  const cardW = Math.floor((WIDTH - 144 - gap * 2) / 3);
  const cardH = 225; // Cartes plus hautes

  // Carte 1: PnL (Texte Bleu si positif/négatif)
  drawMetricCard(ctx, {
    x: 72, y: cardY, w: cardW, h: cardH,
    title: "Net PnL",
    value: pnlUsd === null ? "—" : (pnlUsd >= 0 ? "+" : "") + formatUSD(pnlUsd),
    subtitleLeft: "Global Rank",
    subtitleRight: pnlRank ? `#${pnlRank}` : "—",
    isBlueValue: true, // Le PnL est mis en valeur en bleu
  });

  // Carte 2: Volume (Blanc pur)
  drawMetricCard(ctx, {
    x: 72 + cardW + gap, y: cardY, w: cardW, h: cardH,
    title: "Volume",
    value: volumeUsd === null ? "—" : formatCompactUSD(volumeUsd),
    subtitleLeft: "Global Rank",
    subtitleRight: volumeRank ? `#${volumeRank}` : "—",
    isBlueValue: false,
  });

  // Carte 3: Trades (Blanc pur)
  drawMetricCard(ctx, {
    x: 72 + (cardW + gap) * 2, y: cardY, w: cardW, h: cardH,
    title: "Activity",
    value: totalTrades === null || totalTrades === 0 ? "—" : `${Number(totalTrades).toLocaleString("en-US")} trades`,
    subtitleLeft: "Global Rank",
    subtitleRight: activityRank ? `#${activityRank}` : "—",
    isBlueValue: false,
  });

  // Footer
  ctx.fillStyle = "rgba(255,255,255,0.40)";
  ctx.font = "bold 16px sans-serif";
  ctx.fillText(`app.brokex.trade`, 72, 595);

  return canvas.toBuffer("image/png");
}

module.exports = { generateTraderCard };