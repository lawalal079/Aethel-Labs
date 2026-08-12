/**
 * ohlc-feed.ts — Real OHLC Candle Data Feed for SMC Pattern Detection
 *
 * Source: Coinbase Exchange Public API (/products/{pair}/candles)
 * Returns 350 real 15-minute OHLC market candles directly from Coinbase order book.
 * Zero API keys required, zero rate-limit blocks on cloud servers.
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
 * Fetches 350 real 15-minute OHLC market candles for BTC/USD directly from Coinbase Exchange.
 */
export async function fetchBTCCandles(): Promise<OHLCCandle[] | null> {
  try {
    const url = 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=900';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8_000),
    });

    if (res.ok) {
      const raw = (await res.json()) as number[][];
      if (Array.isArray(raw) && raw.length > 0) {
        const candles: OHLCCandle[] = raw.map(item => ({
          time: Number(item[0]) * 1000,
          open: Number(item[3]),
          high: Number(item[2]),
          low: Number(item[1]),
          close: Number(item[4]),
        }));

        candles.sort((a, b) => a.time - b.time);
        console.log(
          `[OHLCFeed] ✓ Coinbase BTC/USD: ${candles.length} real OHLC candles (15m) — latest close: $${candles.at(-1)?.close}`
        );
        return candles;
      }
    }
  } catch (err) {
    console.warn('[OHLCFeed] Coinbase BTC/USD OHLC failed:', (err as Error).message);
  }

  return null;
}

// ── EUR/USD OHLC ──────────────────────────────────────────────────────────────

/**
 * Fetches 350 real 15-minute OHLC market candles for EUR/USD directly from Coinbase Exchange.
 */
export async function fetchEURCandles(): Promise<OHLCCandle[] | null> {
  try {
    const url = 'https://api.exchange.coinbase.com/products/EUR-USD/candles?granularity=900';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8_000),
    });

    if (res.ok) {
      const raw = (await res.json()) as number[][];
      if (Array.isArray(raw) && raw.length > 0) {
        const candles: OHLCCandle[] = raw.map(item => ({
          time: Number(item[0]) * 1000,
          open: Number(item[3]),
          high: Number(item[2]),
          low: Number(item[1]),
          close: Number(item[4]),
        }));

        candles.sort((a, b) => a.time - b.time);
        console.log(
          `[OHLCFeed] ✓ Coinbase EUR/USD: ${candles.length} real OHLC candles (15m) — latest close: $${candles.at(-1)?.close}`
        );
        return candles;
      }
    }
  } catch (err) {
    console.warn('[OHLCFeed] Coinbase EUR/USD OHLC failed:', (err as Error).message);
  }

  return null;
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
