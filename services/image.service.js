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
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(num);
}

function formatUSD(num) {
  if (num === null || num === undefined || Number.isNaN(Number(num))) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
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
  ctx.fillStyle = "rgba(255,255,255,0.07)";
  roundRect(ctx, x, y, w, h, 18, true, false);

  let strip = "rgba(255,255,255,0.10)";
  if (accent === "pos") strip = "rgba(60,130,255,0.35)";
  if (accent === "neg") strip = "rgba(255,80,80,0.30)";
  ctx.fillStyle = strip;
  roundRect(ctx, x, y, w, 10, { tl: 18, tr: 18, br: 0, bl: 0 }, true, false);

  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.font = "700 14px Inter, Arial";
  ctx.fillText(title, x + 24, y + 50);

  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = "900 34px Inter, Arial";
  ctx.fillText(value, x + 24, y + 100);

  ctx.fillStyle = "rgba(255,255,255,0.50)";
  ctx.font = "700 14px Inter, Arial";
  ctx.fillText(subtitleLeft, x + 24, y + 152);

  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = "800 14px Inter, Arial";
  const textW = ctx.measureText(subtitleRight).width;
  ctx.fillText(subtitleRight, x + w - 24 - textW, y + 152);
}

function generateTraderCard({ address, ranks }) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = "#05060a";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const grad = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  grad.addColorStop(0, "rgba(50,120,255,0.18)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Header
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = "800 44px Inter, Arial";
  ctx.fillText("BROKEX", 72, 105);

  ctx.fillStyle = "rgba(255,255,255,0.60)";
  ctx.font = "600 22px Inter, Arial";
  ctx.fillText("Trader Stats Card", 72, 142);

  ctx.fillStyle = "rgba(255,255,255,0.10)";
  roundRect(ctx, WIDTH - 280, 70, 208, 44, 14, true, false);

  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = "700 16px Inter, Arial";
  ctx.fillText("Powered by Pharos", WIDTH - 255, 99);

  // Address box
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  roundRect(ctx, 72, 175, WIDTH - 144, 64, 16, true, false);

  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.font = "600 16px Inter, Arial";
  ctx.fillText("Wallet", 96, 203);

  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = "700 22px Inter, Arial";
  ctx.fillText(address, 96, 232);

  // Stats
  const pnlUsd = fromE6(ranks.pnl.value);
  const volumeUsd = fromE6(ranks.volume.value);
  const totalTrades = ranks.activity.value;

  const cardY = 270;
  const gap = 24;
  const cardW = Math.floor((WIDTH - 144 - gap * 2) / 3);
  const cardH = 190;

  // Card 1: PnL
  drawMetricCard(ctx, {
    x: 72, y: cardY, w: cardW, h: cardH,
    title: "Realized PnL",
    value: pnlUsd === null ? "—" : (pnlUsd >= 0 ? "+" : "") + formatUSD(pnlUsd),
    subtitleLeft: "Global Rank",
    subtitleRight: ranks.pnl.rank ? `#${ranks.pnl.rank}` : "—",
    accent: pnlUsd === null ? "neutral" : pnlUsd >= 0 ? "pos" : "neg",
  });

  // Card 2: Volume
  drawMetricCard(ctx, {
    x: 72 + cardW + gap, y: cardY, w: cardW, h: cardH,
    title: "Total Volume",
    value: volumeUsd === null ? "—" : formatCompactUSD(volumeUsd),
    subtitleLeft: "Global Rank",
    subtitleRight: ranks.volume.rank ? `#${ranks.volume.rank}` : "—",
    accent: "neutral",
  });

  // Card 3: Trades
  drawMetricCard(ctx, {
    x: 72 + (cardW + gap) * 2, y: cardY, w: cardW, h: cardH,
    title: "Activity",
    value: totalTrades === null || totalTrades === 0 ? "—" : `${Number(totalTrades).toLocaleString("en-US")} trades`,
    subtitleLeft: "Global Rank",
    subtitleRight: ranks.activity.rank ? `#${ranks.activity.rank}` : "—",
    accent: "neutral",
  });

  // Footer
  ctx.fillStyle = "rgba(255,255,255,0.40)";
  ctx.font = "600 14px Inter, Arial";
  ctx.fillText(`brokex.trade/${shortAddr(address)}`, 72, 540);

  return canvas.toBuffer("image/png");
}

module.exports = { generateTraderCard };