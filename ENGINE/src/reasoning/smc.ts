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

import { GoogleGenAI } from '@google/genai';
import { formatCandlesForPrompt, type OHLCCandle } from '../lib/ohlc-feed';

// ── API Key Rotation ──────────────────────────────────────────────────────────

let _keyIndex = 0;

function getNextApiKey(): string | null {
  const raw = process.env.GEMINI_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY || '';
  if (!raw) return null;
  // Support comma-separated keys: KEY1,KEY2,KEY3
  const keys = raw.split(',').map(k => k.trim()).filter(Boolean);
  if (keys.length === 0) return null;
  const key = keys[_keyIndex % keys.length];
  _keyIndex++;
  return key;
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
}

// ── Gemini Prompt Builder ─────────────────────────────────────────────────────

function buildSMCPrompt(ctx: SMCContext): string {
  const candleCount = ctx.candles.length;

  const positionBlock = ctx.activePosition
    ? `ACTIVE POSITION:
  - Asset Held:   ${ctx.activePosition.heldAsset}
  - Entry Price:  $${ctx.activePosition.entryPrice}
  - Current Spot: $${ctx.currentPrice}
  - Profit/Loss:  ${calculatePnl(ctx.activePosition.entryPrice, ctx.currentPrice)}%
  - Target TP:    $${ctx.activePosition.tpPrice ?? 'N/A'} (1:2 R:R)
  - Target SL:    $${ctx.activePosition.slPrice ?? 'N/A'} (Structural Pattern Low)`
    : `ACTIVE POSITION: None (Portfolio is in 100% USDC, looking for SMC entry setup)`;

  const candleBlock = candleCount > 0
    ? `OHLC CANDLE DATA (30-min bars, oldest → newest, last ${Math.min(candleCount, 40)} shown):
${formatCandlesForPrompt(ctx.candles, 40)}

LATEST CLOSE: $${ctx.candles.at(-1)?.close ?? ctx.currentPrice}
LIVE SPOT:    $${ctx.currentPrice}`
    : `PRICE DATA: Live spot only — $${ctx.currentPrice}`;

  return `You are SMC Alpha Executor — an autonomous DeFi trading agent using Smart Money Concepts (SMC) analysis.

CHAIN: Arc Testnet (Circle App Kit spot swaps)
SUPPORTED TOKENS: USDC, EURC, cirBTC
TOKEN MAP: cirBTC = Bitcoin on Arc Testnet. USDC → cirBTC = buying BTC. USDC → EURC = buying Euro.

CURRENT MARKET STATE:
  - Price Pair:   ${ctx.pricePairLabel}
  - Candle Count: ${candleCount} real 30-min OHLC bars available for multi-day market structure analysis
  - Live Spot:    $${ctx.currentPrice}

${candleBlock}

WALLET BALANCES:
  - USDC:   ${ctx.balances.USDC}
  - EURC:   ${ctx.balances.EURC}
  - cirBTC: ${ctx.balances.cirBTC}

${positionBlock}

TRADING RULES (each candle above has real O/H/L/C wick data — analyze it mathematically):
1. ENTRY — BTC/USD pair (no open position):
   - OrderBlock: cluster of low-close candles before a strong bullish impulse.
     patternLow = LOW of the OrderBlock candle. patternHigh = HIGH of the OrderBlock candle.
   - FairValueGap (FVG): candle[N].high < candle[N+2].low — a gap in the 3-candle impulse.
     patternLow = candle[N].high (gap bottom). patternHigh = candle[N+2].low (gap top).
   - LiquiditySweep: a wick LOW pierced below a prior multi-candle swing low, then closed above.
     patternLow = the sweep wick low. patternHigh = the reversal candle's close.
   - If live spot price is RETRACING into or INSIDE one of these bullish zones → SWAP: fromToken="USDC", toToken="cirBTC".

2. ENTRY — EUR/USD pair (no open position):
   - Same pattern rules. If bullish → SWAP: fromToken="USDC", toToken="EURC".

3. TAKE PROFIT (open position):
   - Price has reached or exceeded tpPrice (calculated via 1:2 Risk-to-Reward ratio above entry).
   - SWAP held asset back to USDC. patternDetected="TakeProfit".

4. STOP LOSS (open position):
   - Price has dropped to or below slPrice (defined by structural patternLow / swing low of entry setup).
   - SWAP held asset back to USDC. patternDetected="StopLoss".

5. HOLD — No active entry zone being retested OR no clear setup at current price.
   - You MUST identify any active OrderBlock, FairValueGap, or LiquiditySweep on the 336-candle chart!
   - You MUST populate patternLow and patternHigh with the exact numeric price boundaries of that zone (e.g. patternLow: 63800, patternHigh: 64150)!
   - In reasoning, explain the exact price range and current distance (e.g. "FVG gap at $63,800–$64,150; spot $63,485 is below. Holding until price retraces to $63,800 to buy.").

CRITICAL: Evaluate the price action precisely and return the JSON response format below.

RESPONSE FORMAT — return ONLY this JSON, no markdown:
{"action": "SWAP" or "HOLD", "fromToken": "USDC"/"EURC"/"cirBTC", "toToken": "USDC"/"EURC"/"cirBTC", "amountIn": "<number string>", "patternDetected": "OrderBlock"/"FairValueGap"/"LiquiditySweep"/"TakeProfit"/"StopLoss"/"None", "patternLow": <number or null>, "patternHigh": <number or null>, "reasoning": "<exact price analysis and trigger condition, max 120 chars>"}`;
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
  else if (/fair\s*value\s*gap|fvg/i.test(rawPattern)) pattern = 'FairValueGap';
  else if (/liquidity\s*sweep|breaker/i.test(rawPattern)) pattern = 'LiquiditySweep';
  else if (/take\s*profit/i.test(rawPattern)) pattern = 'TakeProfit';
  else if (/stop\s*loss/i.test(rawPattern)) pattern = 'StopLoss';
  else if (['OrderBlock', 'FairValueGap', 'LiquiditySweep', 'TakeProfit', 'StopLoss', 'None'].includes(rawPattern)) {
    pattern = rawPattern as SMCPattern;
  }

  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning
    : typeof obj.comment === 'string' ? obj.comment
    : typeof obj.explanation === 'string' ? obj.explanation
    : 'SMC analysis complete.';

  const patternLow = typeof obj.patternLow === 'number' ? obj.patternLow
    : typeof obj.patternLow === 'string' && !isNaN(parseFloat(obj.patternLow)) ? parseFloat(obj.patternLow)
    : undefined;

  const patternHigh = typeof obj.patternHigh === 'number' ? obj.patternHigh
    : typeof obj.patternHigh === 'string' && !isNaN(parseFloat(obj.patternHigh)) ? parseFloat(obj.patternHigh)
    : undefined;

  return {
    action,
    fromToken,
    toToken,
    amountIn: amountInStr,
    patternDetected: pattern,
    reasoning,
    patternLow,
    patternHigh,
  };
}

// ── Gemini Evaluation Entry Point ─────────────────────────────────────────────

export async function evaluateSMCStrategy(ctx: SMCContext): Promise<SMCDecision> {
  const apiKey = getNextApiKey();

  if (!apiKey) {
    console.warn('[SMC] GEMINI_API_KEY missing — checking locked decision...');
    const locked = getLockedDecision();
    if (locked) {
      console.log('[SMC] ♻️ Re-serving locked SWAP decision (no API key available).');
      return locked;
    }
    return {
      action: 'HOLD',
      fromToken: 'USDC',
      toToken: 'USDC',
      amountIn: '0.00',
      patternDetected: 'None',
      reasoning: 'GEMINI_API_KEY not configured — agent holding in USDC.',
    };
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    const promptText = buildSMCPrompt(ctx);
    console.log(`[SMC] Sending ${ctx.candles.length} candles to Gemini 2.5 Flash (key #${_keyIndex}) for SMC evaluation...`);

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: promptText,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.1,
      },
    });

    const responseText = response.text?.trim() ?? '';
    console.log(`[SMC] Gemini 2.5 Flash Raw Response: ${responseText}`);

    const parsed = JSON.parse(responseText);
    const validated = validateDecision(parsed);
    console.log(`[SMC] Validated SMC Decision: Action=${validated.action} | Pattern=${validated.patternDetected} | Reasoning="${validated.reasoning}"`);

    // Lock-in SWAP decisions so they persist through API failures
    lockDecision(validated);

    return validated;

  } catch (err: any) {
    console.error('[SMC] Gemini evaluation error:', err.message || err);

    // If API fails but we have a locked SWAP decision, re-serve it
    const locked = getLockedDecision();
    if (locked) {
      console.log('[SMC] ♻️ API failed but re-serving locked SWAP decision.');
      return locked;
    }

    return {
      action: 'HOLD',
      fromToken: 'USDC',
      toToken: 'USDC',
      amountIn: '0.00',
      patternDetected: 'None',
      reasoning: `Gemini API fallback (${err.message || 'eval error'}) — holding position safely.`,
    };
  }
}
