import { Router } from "express";

const router = Router();
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
let cachedHistory: { symbol: string; history: { time: number; price: number }[] }[] = [];
let historyCachedAt = 0;
let cachedPrices: { symbol: string; price: number }[] = [];
let pricesCachedAt = 0;

async function fetchPrices() {
  const now = Date.now();
  if (cachedPrices.length && now - pricesCachedAt < 800) return cachedPrices;
  const tickerUrl = "https://api.binance.com/api/v3/ticker/price?symbols=" + encodeURIComponent(JSON.stringify(SYMBOLS));
  const response = await fetch(tickerUrl);
  if (!response.ok) throw new Error(`Binance ticker API returned ${response.status}`);
  const data = await response.json();
  cachedPrices = data.map((item: { symbol: string; price: string }) => ({ symbol: item.symbol.replace("USDT", ""), price: Number(item.price) }));
  pricesCachedAt = now;
  return cachedPrices;
}

async function fetchHistory() {
  const now = Date.now();
  if (cachedHistory.length && now - historyCachedAt < 30000) return cachedHistory;
  const historyResults = await Promise.all(SYMBOLS.map(async (symbol) => {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=60`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Binance klines API returned ${response.status} for ${symbol}`);
    const candles = await response.json();
    return { symbol: symbol.replace("USDT", ""), history: candles.map((candle: unknown[]) => ({ time: Number(candle[0]), price: Number(candle[4]) })) };
  }));
  cachedHistory = historyResults;
  historyCachedAt = now;
  return cachedHistory;
}

router.get("/", async (_req, res, next) => {
  try {
    const [prices, history] = await Promise.all([fetchPrices(), fetchHistory()]);
    res.json({ source: "binance", prices, history, updatedAt: new Date().toISOString() });
  } catch (error) { next(error); }
});

export default router;
