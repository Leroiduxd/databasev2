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

function roundRect(ctx, x, y, w, h, r, fill, stroke) {
  const radius = typeof r === "number" ? { tl: r, tr: r, br: r, bl: r } : r;
  ctx.beginPath();
  ctx.moveTo(x + radius.tl, y);
  ctx.lineTo(x + w - radius.tr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius.tr);
  ctx.lineTo(x + w, y + h - radius.br);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius.br, y + h);
  ctx.lineTo(x + radius.bl, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius.bl);
  ctx.lineTo(x, y + radius.tl);
  ctx.quadraticCurveTo(x, y, x + radius.tl, y);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

function drawMetricCard(ctx, { x, y, w, h, title, value, subtitleLeft, subtitleRight, accent }) {
  ctx.fillStyle = "rgba(255,255,255,0.03)";
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 18, true, true);

  let stripColor = "rgba(255,255,255,0.15)";
  if (accent === "pos") stripColor = "#00FF9D";
  if (accent === "neg") stripColor = "#FF3366";
  
  ctx.fillStyle = stripColor;
  roundRect(ctx, x, y, w, 4, { tl: 18, tr: 18, br: 0, bl: 0 }, true, false);

  ctx.fillStyle = "rgba(255,255,255,0.50)";
  ctx.font = "700 14px Inter, Arial";
  ctx.fillText(title.toUpperCase(), x + 24, y + 45);

  ctx.fillStyle = accent === "neutral" ? "#FFFFFF" : stripColor;
  ctx.font = "900 34px Inter, Arial";
  
  let displayValue = value;
  if (ctx.measureText(displayValue).width > w - 48) {
     ctx.font = "800 26px Inter, Arial";
  }
  ctx.fillText(displayValue, x + 24, y + 95);

  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(x + 24, y + 130, w - 48, 1);

  ctx.fillStyle = "rgba(255,255,255,0.40)";
  ctx.font = "600 13px Inter, Arial";
  ctx.fillText(subtitleLeft, x + 24, y + 162);

  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = "800 14px Inter, Arial";
  const textW = ctx.measureText(subtitleRight).width;
  ctx.fillText(subtitleRight, x + w - 24 - textW, y + 162);
}

function generateTraderCard({ address, ranks }) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#0B0E17";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const glowLeft = ctx.createRadialGradient(0, 0, 0, 0, 0, 800);
  glowLeft.addColorStop(0, "rgba(0, 229, 255, 0.15)"); 
  glowLeft.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = glowLeft;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const glowRight = ctx.createRadialGradient(WIDTH, HEIGHT, 0, WIDTH, HEIGHT, 800);
  glowRight.addColorStop(0, "rgba(110, 56, 255, 0.15)"); 
  glowRight.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = glowRight;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "900 44px Inter, Arial";
  ctx.fillText("BROKEX", 72, 105);

  ctx.fillStyle = "#00E5FF";
  ctx.fillText("PROTOCOL", 72 + ctx.measureText("BROKEX ").width, 105);

  ctx.fillStyle = "rgba(255,255,255,0.50)";
  ctx.font = "600 20px Inter, Arial";
  ctx.fillText("ON-CHAIN PERFORMANCE", 72, 142);

  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth = 1;
  roundRect(ctx, WIDTH - 280, 70, 208, 44, 14, true, true);

  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = "700 16px Inter, Arial";
  ctx.fillText("Powered by Pharos", WIDTH - 255, 99);

  ctx.fillStyle = "rgba(255,255,255,0.03)";
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  roundRect(ctx, 72, 175, WIDTH - 144, 64, 16, true, true);

  ctx.fillStyle = "#00FF9D";
  ctx.beginPath();
  ctx.arc(96, 207, 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.font = "600 16px Inter, Arial";
  ctx.fillText("Trader Wallet", 115, 203);

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "700 22px Inter, Arial";
  ctx.fillText(address, 115, 230);

  const activityRank = ranks?.activity?.rank ?? null;
  const totalTrades = ranks?.activity?.value ?? null;
  const volumeRank = ranks?.volume?.rank ?? null;
  const volumeUsd = fromE6(ranks?.volume?.value);
  const pnlRank = ranks?.pnl?.rank ?? null;
  const pnlUsd = fromE6(ranks?.pnl?.value);

  const cardY = 270;
  const gap = 24;
  const cardW = Math.floor((WIDTH - 144 - gap * 2) / 3);
  const cardH = 190;

  drawMetricCard(ctx, {
    x: 72, y: cardY, w: cardW, h: cardH,
    title: "Net PnL",
    value: pnlUsd === null ? "—" : (pnlUsd >= 0 ? "+" : "") + formatUSD(pnlUsd),
    subtitleLeft: "Global Rank",
    subtitleRight: pnlRank ? `#${pnlRank}` : "—",
    accent: pnlUsd === null ? "neutral" : pnlUsd >= 0 ? "pos" : "neg",
  });

  drawMetricCard(ctx, {
    x: 72 + cardW + gap, y: cardY, w: cardW, h: cardH,
    title: "Volume",
    value: volumeUsd === null ? "—" : formatCompactUSD(volumeUsd),
    subtitleLeft: "Global Rank",
    subtitleRight: volumeRank ? `#${volumeRank}` : "—",
    accent: "neutral",
  });

  drawMetricCard(ctx, {
    x: 72 + (cardW + gap) * 2, y: cardY, w: cardW, h: cardH,
    title: "Activity",
    value: totalTrades === null || totalTrades === 0 ? "—" : `${Number(totalTrades).toLocaleString("en-US")} trades`,
    subtitleLeft: "Global Rank",
    subtitleRight: activityRank ? `#${activityRank}` : "—",
    accent: "neutral",
  });

  ctx.fillStyle = "rgba(255,255,255,0.30)";
  ctx.font = "600 14px Inter, Arial";
  ctx.fillText(`app.brokex.trade`, 72, 540);

  return canvas.toBuffer("image/png");
}

module.exports = { generateTraderCard };