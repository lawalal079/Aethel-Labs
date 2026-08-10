/**
 * ohlc-feed.ts — Real OHLC Candle Data Feed for SMC Pattern Detection
 *
 * Source 1: Binance public API (/api/v3/klines) — Primary (No rate limits)
 * Source 2: CoinGecko public API (/coins/{id}/ohlc) — Fallback
 *
 * Returns true OHLC bars with real wicks and price action.
 */

export interface OHLCCandle {
  time: number;   // Unix timestamp ms (open time of bar)
  open: number;
  high: number;
  low: number;
  close: number;
}

// ── BTC/USD OHLC ──────────────────────────────────────────────────────────────

/**
 * Fetches real 30-min OHLC candles for BTC/USD from Binance with CoinGecko fallback.
 *
 * @param days  1 = last ~24h (48 bars), 2 = last ~48h (96 bars). Default: 1.
 */
export async function fetchBTCCandles(days: 1 | 2 | 7 = 1): Promise<OHLCCandle[] | null> {
  const limit = days === 1 ? 48 : days === 2 ? 96 : 336;

  // 1. Primary: Binance public API (100% reliable, zero rate limits)
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=30m&limit=${limit}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8_000),
    });

    if (res.ok) {
      const raw = (await res.json()) as any[];
      if (Array.isArray(raw) && raw.length > 0) {
        const candles: OHLCCandle[] = raw.map((item: any) => ({
          time: Number(item[0]),
          open: parseFloat(item[1]),
          high: parseFloat(item[2]),
          low: parseFloat(item[3]),
          close: parseFloat(item[4]),
        }));

        candles.sort((a, b) => a.time - b.time);
        console.log(
          `[OHLCFeed] ✓ Binance BTC/USDT: ${candles.length} OHLC candles (30m) — latest close: $${candles.at(-1)?.close}`
        );
        return candles;
      }
    }
  } catch (err) {
    console.warn('[OHLCFeed] Binance klines failed:', (err as Error).message);
  }

  // 2. Fallback: CoinGecko public API
  try {
    const url = `https://api.coingecko.com/api/v3/coins/bitcoin/ohlc?vs_currency=usd&days=${days}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });

    if (res.ok) {
      const raw = (await res.json()) as [number, number, number, number, number][];
      if (Array.isArray(raw) && raw.length > 0) {
        const candles: OHLCCandle[] = raw.map(([time, open, high, low, close]) => ({
          time,
          open,
          high,
          low,
          close,
        }));

        candles.sort((a, b) => a.time - b.time);
        console.log(
          `[OHLCFeed] ✓ CoinGecko BTC/USD: ${candles.length} OHLC candles (${days}d) — latest close: $${candles.at(-1)?.close}`
        );
        return candles;
      }
    }
  } catch (err) {
    console.warn('[OHLCFeed] CoinGecko OHLC fetch failed:', (err as Error).message);
  }

  return null;
}

// ── EUR/USD OHLC ──────────────────────────────────────────────────────────────

export async function fetchEURCandles(): Promise<OHLCCandle[] | null> {
  return null;
}

/**
 * Creates a synthetic single OHLC bar from a spot price.
 */
export function syntheticCandle(price: number): OHLCCandle {
  return {
    time: Date.now(),
    open: price,
    high: price * 1.0005,
    low: price * 0.9995,
    close: price,
  };
}

/**
 * Formats OHLC candles into a clean Markdown table for Gemini prompts.
 */
export function formatCandlesForPrompt(candles: OHLCCandle[], maxCount?: number): string {
  if (!candles || candles.length === 0) return 'No candle data available.';

  const targetCandles = maxCount ? candles.slice(-maxCount) : candles;

  const lines: string[] = [
    'Time (UTC) | Open ($) | High ($) | Low ($) | Close ($)',
    '---|---|---|---|---',
  ];

  for (const c of targetCandles) {
    const timeStr = new Date(c.time).toISOString().replace('T', ' ').slice(0, 16);
    lines.push(`${timeStr} | ${c.open.toFixed(2)} | ${c.high.toFixed(2)} | ${c.low.toFixed(2)} | ${c.close.toFixed(2)}`);
  }

  return lines.join('\n');
}
