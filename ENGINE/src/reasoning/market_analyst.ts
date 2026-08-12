/**
 * market_analyst.ts — Shared Decision-Engine Architecture for Autonomous Agents
 *
 * Runs a single Market Analyst process per agent type (e.g. 'smc_alpha_executor')
 * once per interval across ALL users.
 *
 * Benefits:
 *   1. Eliminates API rate limits (Gemini 429 & CoinGecko 429) regardless of N active users.
 *   2. Exactly 1 Gemini call & 1 CoinGecko call per interval per agent type.
 *   3. Individual user daemons read the shared decision, verify freshness, pay nanopayment task fees,
 *      and execute swaps autonomously from their own Trading Wallets.
 */

import { fetchBTCCandles, fetchBTCCandles1H, type OHLCCandle } from '../lib/ohlc-feed';
import { evaluateSMCStrategy, type SMCDecision, type SMCContext } from './smc';

export interface SharedDecision extends SMCDecision {
  timestamp: number;
  price: number;
  pricePairLabel: string;
  agentId: string;
}

// ── In-Memory Store & State ───────────────────────────────────────────────────

const _sharedDecisionStore = new Map<string, SharedDecision>();
const _analystIntervals = new Map<string, NodeJS.Timeout>();

let _totalAnalystGeminiCalls = 0;
let _totalAnalystCoinGeckoCalls = 0;

export function getAnalystMetrics() {
  return {
    geminiCalls: _totalAnalystGeminiCalls,
    coingeckoCalls: _totalAnalystCoinGeckoCalls,
    activeAnalysts: _analystIntervals.size,
  };
}

// ── Market Data Helpers ───────────────────────────────────────────────────────

/** Fetches EUR/USD spot rate from Coinbase public API (mainnet). */
async function fetchEURUSDPrice(): Promise<number | null> {
  try {
    const res = await fetch('https://api.coinbase.com/v2/prices/EUR-USD/spot', {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: any = await res.json();
    const price = parseFloat(data?.data?.amount);
    if (isNaN(price) || price <= 0) throw new Error('Invalid price');
    return price;
  } catch {
    return null;
  }
}

/** Fetches BTC/USD spot price with multi-source fallback (Coinbase -> Binance -> CoinGecko). */
async function fetchBTCUSDPrice(): Promise<number | null> {
  // 1. Try Coinbase public API (No rate limits on mainnet)
  try {
    const res = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot', {
      signal: AbortSignal.timeout(6_000),
    });
    if (res.ok) {
      const data: any = await res.json();
      const price = parseFloat(data?.data?.amount);
      if (!isNaN(price) && price > 0) return price;
    }
  } catch {}

  // 2. Try Binance public API
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', {
      signal: AbortSignal.timeout(6_000),
    });
    if (res.ok) {
      const data: any = await res.json();
      const price = parseFloat(data?.price);
      if (!isNaN(price) && price > 0) return price;
    }
  } catch {}

  // 3. Fallback to CoinGecko
  try {
    _totalAnalystCoinGeckoCalls++;
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      { signal: AbortSignal.timeout(6_000) }
    );
    if (res.ok) {
      const data: any = await res.json();
      const price = data?.bitcoin?.usd;
      if (typeof price === 'number' && price > 0) return price;
    }
  } catch (err) {
    console.warn('[MarketAnalyst] All BTC/USD spot providers failed:', (err as Error).message);
  }

  return null;
}

// ── Analyst Cycle Execution ────────────────────────────────────────────────────

/**
 * Runs a single Market Analyst evaluation for a specific agent type.
 * Fetches real market OHLC candles, calls Gemini Flash ONCE, and stores
 * the decision in the shared in-memory store.
 */
export async function runMarketAnalystCycle(agentId: string = 'smc_alpha_executor'): Promise<SharedDecision | null> {
  const canonicalId = agentId.includes('smc') ? 'smc_alpha_executor' : agentId;
  console.log(`\n📊 [Market Analyst] Running single analysis cycle for agent type "${canonicalId}"...`);

  // 1. Fetch mainnet prices
  const [eurUsd, btcUsd] = await Promise.all([fetchEURUSDPrice(), fetchBTCUSDPrice()]);
  const validBtcUsd = btcUsd ?? 64000;

  // 2. Fetch real OHLC candles (15m LTF + 1H HTF) from Coinbase Exchange
  _totalAnalystCoinGeckoCalls++;
  const [btcCandles, btcCandles1H] = await Promise.all([
    fetchBTCCandles(),
    fetchBTCCandles1H(),
  ]);

  // 3. Build neutral SMCContext for Gemini evaluation
  const smcCtx: SMCContext = {
    balances: { USDC: '1000.000000', EURC: '0.000000', cirBTC: '0.00000000' },
    activePosition: null,
    currentPrice: validBtcUsd,
    pricePairLabel: 'BTC/USD',
    candles: btcCandles ?? [],
    candles1H: btcCandles1H ?? [],
  };

  // 4. Call Gemini Flash ONCE
  _totalAnalystGeminiCalls++;
  try {
    const decision = await evaluateSMCStrategy(smcCtx);

    const shared: SharedDecision = {
      ...decision,
      timestamp: Date.now(),
      price: validBtcUsd,
      pricePairLabel: 'BTC/USD',
      agentId: canonicalId,
    };

    _sharedDecisionStore.set(canonicalId, shared);
    console.log(
      `[Market Analyst] ✓ Decision stored for "${canonicalId}": Action=${shared.action} | Pattern=${shared.patternDetected} | ` +
      `Total Gemini Calls: ${_totalAnalystGeminiCalls} | Total CoinGecko Calls: ${_totalAnalystCoinGeckoCalls}`
    );

    return shared;
  } catch (err) {
    const errMsg = (err as Error).message;
    console.warn(`[Market Analyst] Error during Gemini evaluation: ${errMsg} — storing fallback HOLD decision.`);
    const fallbackShared: SharedDecision = {
      action: 'HOLD',
      fromToken: 'USDC',
      toToken: 'USDC',
      amountIn: '0.00',
      patternDetected: 'None',
      reasoning: `Market Analyst fallback due to error: ${errMsg}`,
      timestamp: Date.now(),
      price: validBtcUsd,
      pricePairLabel: 'BTC/USD',
      agentId: canonicalId,
    };
    _sharedDecisionStore.set(canonicalId, fallbackShared);
    return fallbackShared;
  }
}

// ── Public Store API ──────────────────────────────────────────────────────────

/**
 * Returns the latest shared decision for an agent type if fresh enough.
 * If the stored decision is older than maxAgeMs (default: 2x interval), returns null.
 */
export function getLatestSharedDecision(
  agentId: string = 'smc_alpha_executor',
  maxAgeMs: number = 720_000
): SharedDecision | null {
  const canonicalId = agentId.includes('smc') ? 'smc_alpha_executor' : agentId;
  const stored = _sharedDecisionStore.get(canonicalId);

  if (!stored) {
    return null;
  }

  const age = Date.now() - stored.timestamp;
  if (age > maxAgeMs) {
    console.warn(`[Market Analyst] Decision for "${canonicalId}" is stale (${Math.round(age / 1000)}s > ${Math.round(maxAgeMs / 1000)}s max).`);
    return null;
  }

  return stored;
}

/**
 * Ensures the shared Market Analyst background loop is running for an agent type.
 * Idempotent — will not duplicate intervals if called multiple times for the same agentId.
 */
export function ensureMarketAnalystRunning(
  agentId: string = 'smc_alpha_executor',
  intervalSeconds: number = 300
): void {
  const canonicalId = agentId.includes('smc') ? 'smc_alpha_executor' : agentId;
  if (_analystIntervals.has(canonicalId)) {
    return;
  }

  console.log(`[Market Analyst] Initializing shared Market Analyst loop for "${canonicalId}" every ${intervalSeconds}s...`);

  // Run first cycle immediately
  void runMarketAnalystCycle(canonicalId);

  const handle = setInterval(() => {
    void runMarketAnalystCycle(canonicalId);
  }, intervalSeconds * 1000);

  _analystIntervals.set(canonicalId, handle);
}

/**
 * Stops the shared Market Analyst background loop for an agent type.
 */
export function stopMarketAnalyst(agentId: string = 'smc_alpha_executor'): void {
  const canonicalId = agentId.includes('smc') ? 'smc_alpha_executor' : agentId;
  const handle = _analystIntervals.get(canonicalId);
  if (handle) {
    clearInterval(handle);
    _analystIntervals.delete(canonicalId);
    console.log(`[Market Analyst] Stopped shared analyst loop for "${canonicalId}".`);
  }
}

/**
 * Manually set a shared decision (useful for unit tests & simulations).
 */
export function setSharedDecisionForTest(agentId: string, decision: SharedDecision): void {
  const canonicalId = agentId.includes('smc') ? 'smc_alpha_executor' : agentId;
  _sharedDecisionStore.set(canonicalId, decision);
}
