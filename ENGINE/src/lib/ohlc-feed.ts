/**
 * ohlc-feed.ts — Real OHLC Candle Data Feed for SMC Pattern Detection
 *
 * Source: CoinGecko public API (/coins/{id}/ohlc)
 *   - No API key required
 *   - Returns true OHLC bars with real wicks (not spot-price approximations)
 *   - BTC/USD: 30-min bars, up to 48 candles per day (days=1), 96 for days=2
 *   - EUR/USD: Not available via CoinGecko (crypto-only) — returns null;
 *     executor falls back to spot-price history for EUR pairs (documented limitation)
 *
 * Format returned by CoinGecko: [ [timestamp_ms, open, high, low, close], ... ]
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
 * Fetches real 30-min OHLC candles for BTC/USD from CoinGecko.
 * Returns null on failure — callers must handle gracefully.
 *
 * @param days  1 = last ~24h (48 bars), 2 = last ~48h (96 bars). Default: 1.
 */
export async function fetchBTCCandles(days: 1 | 2 | 7 = 1): Promise<OHLCCandle[] | null> {
  try {
    const url = `https://api.coingecko.com/api/v3/coins/bitcoin/ohlc?vs_currency=usd&days=${days}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });

    if (!res.ok) {
      console.warn(`[OHLCFeed] CoinGecko BTC OHLC HTTP ${res.status} — ${await res.text().catch(() => '')}`);
      return null;
    }

    const raw = await res.json() as [number, number, number, number, number][];

    if (!Array.isArray(raw) || raw.length === 0) {
      console.warn('[OHLCFeed] CoinGecko returned empty or malformed OHLC array');
      return null;
    }

    const candles: OHLCCandle[] = raw.map(([time, open, high, low, close]) => ({
      time, open, high, low, close,
    }));

    // CoinGecko returns oldest-first already — verify and sort defensively
    candles.sort((a, b) => a.time - b.time);

    console.log(`[OHLCFeed] ✓ BTC/USD: ${candles.length} OHLC candles (30-min, ${days}d) — latest close: $${candles.at(-1)?.close}`);
    return candles;
  } catch (err) {
    console.warn('[OHLCFeed] BTC OHLC fetch failed:', (err as Error).message);
    return null;
  }
}

// ── EUR/USD OHLC ──────────────────────────────────────────────────────────────

/**
 * EUR/USD OHLC is not available from CoinGecko (crypto-only API).
 * Returns null — the executor loop uses spot-price history accumulation for EUR pairs.
 * This is a documented limitation: EUR SMC analysis uses approximate price ticks,
 * not true OHLC candles. BTC is the primary pair and has full OHLC support.
 */
export async function fetchEURCandles(): Promise<OHLCCandle[] | null> {
  // Future: Could use Twelve Data, Alpha Vantage, or a forex broker API (all require API keys).
  // For now EUR/USD remains on spot-price tick history — secondary pair, acceptable trade-off.
  return null;
}

// ── Synthetic Candle Fallback ─────────────────────────────────────────────────

/**
 * Creates a minimal single synthetic candle from a spot price.
 * Used as last resort when OHLC fetch fails entirely, so the executor never
 * passes an empty candle array to Gemini.
 */
export function syntheticCandle(spotPrice: number): OHLCCandle {
  return {
    time: Date.now(),
    open: spotPrice,
    high: spotPrice,
    low: spotPrice,
    close: spotPrice,
  };
}

// ── Formatting Helper (for Gemini prompt) ─────────────────────────────────────

/**
 * Formats a candle array as a compact, human-readable block for the Gemini system prompt.
 * Shows only the last `maxBars` candles to keep token usage bounded.
 */
export function formatCandlesForPrompt(candles: OHLCCandle[], maxBars = 30): string {
  const slice = candles.slice(-maxBars);
  return slice
    .map(c => {
      const dt = new Date(c.time).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
      return `  [${dt}] O:${c.open} H:${c.high} L:${c.low} C:${c.close}`;
    })
    .join('\n');
}
