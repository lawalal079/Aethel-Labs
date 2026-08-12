/**
 * smc.ts — Smart Money Concepts (SMC) Reasoning Engine
 *
 * Implements SMC strategy evaluation powered by Gemini 2.5 Flash:
 * - OrderBlocks (OB)
 * - Fair Value Gaps (FVG)
 * - Liquidity Sweeps (LS)
 * - Risk-to-Reward TP (1:2) & Structural SL
 *
 * Features:
 * - Round-robin API key rotation for multi-key deployments
 * - Decision lock-in: SWAP decisions are cached and re-served when API is exhausted
 */

import { callGemini } from '../agents/utils';
import { formatCandlesForPrompt, type OHLCCandle } from '../lib/ohlc-feed';

// ── API Key Rotation ──────────────────────────────────────────────────────────

let _keyIndex = 0;

function getNextApiKey(): string | null {
  const keys: string[] = [];

  // Support GEMINI_API_KEY, GEMINI_API_KEY2, GEMINI_API_KEY3... or comma-separated lists
  Object.keys(process.env).forEach(envKey => {
    if (/^GEMINI_API_KEY/i.test(envKey) || /^NEXT_PUBLIC_GEMINI_API_KEY/i.test(envKey)) {
      const val = process.env[envKey];
      if (val) {
        val.split(',').forEach(k => {
          const trimmed = k.trim();
          if (trimmed && !keys.includes(trimmed)) {
            keys.push(trimmed);
          }
        });
      }
    }
  });

  if (keys.length === 0) return null;

  const selected = keys[_keyIndex % keys.length];
  _keyIndex++;
  return selected;
}

// ── Decision Lock-In Cache ────────────────────────────────────────────────────
// When Gemini returns a SWAP decision, cache it here. If a subsequent API call
// fails (rate limit, 404, network error), the locked-in decision is re-served
// so the trade still executes. Cleared after the trade is executed or after 15 min.

let _lockedDecision: SMCDecision | null = null;
let _lockedAt = 0;
const LOCK_TTL_MS = 15 * 60 * 1000; // 15 minutes

function lockDecision(d: SMCDecision): void {
  if (d.action === 'SWAP') {
    _lockedDecision = d;
    _lockedAt = Date.now();
    console.log(`[SMC] 🔒 SWAP decision LOCKED: ${d.fromToken} → ${d.toToken} | Pattern=${d.patternDetected}`);
  }
}

function getLockedDecision(): SMCDecision | null {
  if (!_lockedDecision) return null;
  if (Date.now() - _lockedAt > LOCK_TTL_MS) {
    console.log('[SMC] 🔓 Locked SWAP decision expired (15 min TTL). Clearing.');
    _lockedDecision = null;
    return null;
  }
  return _lockedDecision;
}

export function clearLockedDecision(): void {
  if (_lockedDecision) {
    console.log('[SMC] 🔓 Locked SWAP decision cleared (trade executed).');
    _lockedDecision = null;
  }
}

// ── Strategy Configuration Types ──────────────────────────────────────────────

export type SupportedToken = 'USDC' | 'EURC' | 'cirBTC';
export type SMCAction = 'SWAP' | 'HOLD';
export type SMCPattern =
  | 'OrderBlock'
  | 'FairValueGap'
  | 'LiquiditySweep'
  | 'TakeProfit'
  | 'StopLoss'
  | 'None';

export interface ActivePositionInfo {
  heldAsset: string;
  entryPrice: number;
  enteredAt: number;
  tpPrice?: number;
  slPrice?: number;
}

export interface SMCContext {
  balances: {
    USDC: string;
    EURC: string;
    cirBTC: string;
  };
  activePosition: ActivePositionInfo | null;
  currentPrice: number;
  pricePairLabel: string;
  candles: OHLCCandle[];
  candles1H?: OHLCCandle[];
}

export interface SMCDecision {
  action: SMCAction;
  fromToken: SupportedToken;
  toToken: SupportedToken;
  amountIn: string;
  patternDetected: SMCPattern;
  reasoning: string;
  patternLow?: number;
  patternHigh?: number;
  buyAt?: number;
  tpAt?: number;
  slAt?: number;
}

// ── Gemini Prompt Builder ─────────────────────────────────────────────────────

function buildSMCPrompt(ctx: SMCContext): string {
  const ltfCount = ctx.candles.length;
  const htfCount = ctx.candles1H ? ctx.candles1H.length : 0;

  const hasCirBTC = Number(ctx.balances.cirBTC) > 0.00000001;
  const hasEURC   = Number(ctx.balances.EURC) > 0.01;

  let positionBlock = '';
  if (ctx.activePosition) {
    positionBlock = `ACTIVE POSITION:
  - Asset Held:   ${ctx.activePosition.heldAsset}
  - Entry Price:  $${ctx.activePosition.entryPrice}
  - Current Spot: $${ctx.currentPrice}
  - Profit/Loss:  ${calculatePnl(ctx.activePosition.entryPrice, ctx.currentPrice)}%
  - Target TP:    $${ctx.activePosition.tpPrice ?? 'N/A'} (1:2 R:R)
  - Target SL:    $${ctx.activePosition.slPrice ?? 'N/A'} (Structural Pattern Low)`;
  } else if (hasCirBTC || hasEURC) {
    const heldAssets = [
      hasCirBTC ? `${ctx.balances.cirBTC} cirBTC` : '',
      hasEURC ? `${ctx.balances.EURC} EURC` : ''
    ].filter(Boolean).join(' and ');
    positionBlock = `ACTIVE POSITION: User wallet currently holds ${heldAssets}. Evaluate Take Profit, Stop Loss, and Bearish Resistance exit setups to SWAP back to USDC.`;
  } else {
    positionBlock = `ACTIVE POSITION: Portfolio is in 100% USDC cash. Evaluate bullish SMC entry setups to SWAP from USDC into cirBTC or EURC.`;
  }

  const htfBlock = htfCount > 0
    ? `HIGHER TIMEFRAME (1-HOUR BARS — MARKET STRUCTURE, ORDERBLOCKS & BREAKER BLOCKS):
${formatCandlesForPrompt(ctx.candles1H!, 30)}`
    : `HTF DATA: Not available`;

  const ltfBlock = ltfCount > 0
    ? `LOWER TIMEFRAME (15-MIN BARS — ENTRY TIMING & FVG / SWEEPS):
${formatCandlesForPrompt(ctx.candles, 40)}

LATEST CLOSE: $${ctx.candles.at(-1)?.close ?? ctx.currentPrice}
LIVE SPOT:    $${ctx.currentPrice}`
    : `LTF DATA: Live spot only — $${ctx.currentPrice}`;

  return `You are SMC Alpha Executor — an autonomous DeFi trading agent performing Top-Down Smart Money Concepts (SMC) Analysis.

CHAIN: Arc Testnet (Circle App Kit spot swaps)
SUPPORTED TOKENS: USDC, EURC, cirBTC

CURRENT MARKET STATE:
  - Price Pair:   ${ctx.pricePairLabel}
  - Live Spot:    $${ctx.currentPrice}

${htfBlock}

${ltfBlock}

WALLET BALANCES:
  - USDC:   ${ctx.balances.USDC}
  - EURC:   ${ctx.balances.EURC}
  - cirBTC: ${ctx.balances.cirBTC}

${positionBlock}

TOP-DOWN TRADING METHODOLOGY:
Perform full top-down SMC analysis across both timeframes:
1. HTF STRUCTURE (1H): Identify overall market structure on 1H candles.
   - OrderBlock: Cluster of down-close candles before a major bullish impulse.
   - Breaker Block: An OrderBlock that got invalidated by a liquidity sweep, now flipped to support.
   - Mark the HTF OrderBlock or Breaker Block zone (patternLow to patternHigh).
2. LTF ENTRY (15M): Look for entry refinement inside or near the HTF zone.
   - FairValueGap (FVG): Imbalance gap on 15m (candle[N].high < candle[N+2].low).
   - LiquiditySweep: 15m wick low below previous swing low, followed by strong reversal.
3. BUY SETUP (no open position):
   - If live spot is retracing into or inside a bullish OrderBlock, Breaker Block, or FVG zone → action="SWAP", fromToken="USDC", toToken="cirBTC".
   - You MUST specify: buyAt (trigger price), tpAt (1:2 R:R target price above entry), slAt (patternLow structural stop loss).
4. HOLD SETUP:
   - If price has not reached the buy zone, action="HOLD".
   - You MUST identify the target pattern (OrderBlock, Breaker Block, FVG, or LiquiditySweep) and populate:
     patternLow, patternHigh, buyAt (exact trigger entry price), tpAt (take profit), slAt (stop loss).
   - In reasoning, state clearly: "OrderBlock at $63,600–$63,800; spot $63,679 is inside. Buying at $63,680, TP $63,800, SL $63,600."

RESPONSE FORMAT — return ONLY this JSON, no markdown:
{"action": "SWAP" or "HOLD", "fromToken": "USDC"/"EURC"/"cirBTC", "toToken": "USDC"/"EURC"/"cirBTC", "amountIn": "<number string>", "patternDetected": "OrderBlock"/"BreakerBlock"/"FairValueGap"/"LiquiditySweep"/"TakeProfit"/"StopLoss"/"None", "patternLow": <number or null>, "patternHigh": <number or null>, "buyAt": <number or null>, "tpAt": <number or null>, "slAt": <number or null>, "reasoning": "<exact price analysis, trigger price, TP, and SL, max 140 chars>"}`;
}

function calculatePnl(entryPrice: number, currentPrice: number): string {
  if (entryPrice <= 0) return '0.0000';
  return (((currentPrice - entryPrice) / entryPrice) * 100).toFixed(4);
}

// ── Decision Validator ────────────────────────────────────────────────────────

function validateDecision(raw: unknown): SMCDecision {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const validActions: SMCAction[] = ['SWAP', 'HOLD'];
  const validTokens: SupportedToken[] = ['USDC', 'EURC', 'cirBTC'];

  const action = validActions.includes(obj.action as SMCAction) ? (obj.action as SMCAction) : 'HOLD';
  const fromToken = validTokens.includes(obj.fromToken as SupportedToken) ? (obj.fromToken as SupportedToken) : 'USDC';
  const toToken = validTokens.includes(obj.toToken as SupportedToken) ? (obj.toToken as SupportedToken) : 'USDC';

  const amountInStr = typeof obj.amountIn === 'string' ? obj.amountIn
    : typeof obj.amount === 'string' ? obj.amount
    : '0.00';

  // Loose pattern mapping — map unrecognized strings cleanly to "None"
  let pattern: SMCPattern = 'None';
  const rawPattern = String(obj.patternDetected || obj.pattern || '').trim();
  if (/order\s*block/i.test(rawPattern)) pattern = 'OrderBlock';
  else if (/breaker/i.test(rawPattern)) pattern = 'LiquiditySweep';
  else if (/fair\s*value\s*gap|fvg/i.test(rawPattern)) pattern = 'FairValueGap';
  else if (/liquidity\s*sweep/i.test(rawPattern)) pattern = 'LiquiditySweep';
  else if (/take\s*profit/i.test(rawPattern)) pattern = 'TakeProfit';
  else if (/stop\s*loss/i.test(rawPattern)) pattern = 'StopLoss';
  else if (['OrderBlock', 'FairValueGap', 'LiquiditySweep', 'TakeProfit', 'StopLoss', 'None'].includes(rawPattern)) {
    pattern = rawPattern as SMCPattern;
  }

  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning
    : typeof obj.comment === 'string' ? obj.comment
    : typeof obj.explanation === 'string' ? obj.explanation
    : 'SMC analysis complete.';

  const parseNum = (v: unknown) => typeof v === 'number' ? v : typeof v === 'string' && !isNaN(parseFloat(v)) ? parseFloat(v) : undefined;

  return {
    action,
    fromToken,
    toToken,
    amountIn: amountInStr,
    patternDetected: pattern,
    reasoning,
    patternLow: parseNum(obj.patternLow),
    patternHigh: parseNum(obj.patternHigh),
    buyAt: parseNum(obj.buyAt),
    tpAt: parseNum(obj.tpAt),
    slAt: parseNum(obj.slAt),
  };
}

// ── Gemini Evaluation Entry Point ─────────────────────────────────────────────

export async function evaluateSMCStrategy(ctx: SMCContext): Promise<SMCDecision> {
  try {
    const promptText = buildSMCPrompt(ctx);
    console.log(`[SMC] Sending ${ctx.candles.length} candles to Gemini 2.5 Flash for SMC evaluation...`);

    const responseText = await callGemini(promptText, {});
    console.log(`[SMC] Gemini Flash Raw Response: ${responseText}`);

    let cleanJson = responseText.trim();
    const jsonMatch = cleanJson.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (jsonMatch) {
      cleanJson = jsonMatch[1].trim();
    } else if (!cleanJson.startsWith('{')) {
      const firstBrace = cleanJson.indexOf('{');
      const lastBrace = cleanJson.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        cleanJson = cleanJson.substring(firstBrace, lastBrace + 1);
      }
    }

    const parsed = JSON.parse(cleanJson);
    const validated = validateDecision(parsed);
    console.log(`[SMC] Validated SMC Decision: Action=${validated.action} | Pattern=${validated.patternDetected} | Reasoning="${validated.reasoning}"`);

    // Lock-in SWAP decisions so they persist through API failures
    lockDecision(validated);

    return validated;

  } catch (err: any) {
    const rawMsg = String(err?.message || err);
    console.error('[SMC] Gemini evaluation error:', rawMsg);

    // If API fails but we have a locked SWAP decision, re-serve it
    const locked = getLockedDecision();
    if (locked) {
      console.log('[SMC] ♻️ API failed but re-serving locked SWAP decision.');
      return locked;
    }

    let cleanReasoning = `Gemini API fallback — holding position safely.`;
    if (rawMsg.includes('429') || rawMsg.includes('RESOURCE_EXHAUSTED') || rawMsg.includes('Quota')) {
      cleanReasoning = `Gemini API daily/min quota limit reached (429) — holding position safely until reset.`;
    }

    return {
      action: 'HOLD',
      fromToken: 'USDC',
      toToken: 'USDC',
      amountIn: '0.00',
      patternDetected: 'None',
      reasoning: cleanReasoning,
    };
  }
}
