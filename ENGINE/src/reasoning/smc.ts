/**
 * smc.ts — Layer 1: Google Gemini 1.5/2.5 Flash SMC Reasoning Engine
 *
 * Evaluates Smart Money Concepts (Order Blocks, Breaker Blocks, Fair Value Gaps)
 * and emits a strongly-typed trading decision. Uses responseMimeType: "application/json"
 * to guarantee clean JSON output without any markdown wrapping.
 *
 * Architecture: Layer 1 → feeds into Layer 2 (policy gate) → Layer 3 (App Kit swap)
 */

import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { callGemini } from '../agents/utils';
import { type OHLCCandle, formatCandlesForPrompt } from '../lib/ohlc-feed';

export type { OHLCCandle };

// ── Types ─────────────────────────────────────────────────────────────────────

export type SupportedToken = 'USDC' | 'EURC' | 'cirBTC';
export type SMCAction = 'SWAP' | 'HOLD';
export type SMCPattern =
  | 'OrderBlock'
  | 'FairValueGap'
  | 'LiquiditySweep'
  | 'TakeProfit'
  | 'StopLoss'
  | 'None';

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

export interface SMCContext {
  /** USDC / EURC / cirBTC balances in the Trading Wallet */
  balances: { USDC: string; EURC: string; cirBTC: string };
  /** Open trade position, or null if no position is held */
  activePosition: { heldAsset: string; entryPrice: number; amount: string; tpPrice?: number; slPrice?: number } | null;
  /** Live asset price (e.g. EUR/USD rate, BTC/USD) */
  currentPrice: number;
  /** Price for the pair expressed as a human-readable label (e.g. "EUR/USD") */
  pricePairLabel: string;
  /**
   * Real OHLC candle history — oldest first, newest last.
   * Each candle has true open/high/low/close from CoinGecko 30-min bars.
   * Required for genuine SMC pattern detection (FVG, OrderBlock, LiquiditySweep).
   * Minimum 3 candles required; 20-48 candles recommended.
   */
  candles: OHLCCandle[];
}

// ── SMC System Prompt ─────────────────────────────────────────────────────────

function buildSystemPrompt(ctx: SMCContext): string {
  const positionBlock = ctx.activePosition
    ? `OPEN POSITION:
  - Held Asset: ${ctx.activePosition.heldAsset}
  - Entry Price: ${ctx.activePosition.entryPrice}
  - Amount: ${ctx.activePosition.amount}
  - Target Take Profit (1:2 R:R): ${ctx.activePosition.tpPrice ?? 'Structure High'}
  - Target Stop Loss (Structure Low): ${ctx.activePosition.slPrice ?? 'Structure Low'}
  - Unrealised PnL: ${calculatePnl(ctx.activePosition.entryPrice, ctx.currentPrice)}%`
    : 'OPEN POSITION: None (you are in USDC)';

  const candleCount = ctx.candles.length;
  const candleBlock = candleCount > 0
    ? `OHLC CANDLE DATA (30-min bars, oldest → newest, last ${Math.min(candleCount, 30)} shown):
${formatCandlesForPrompt(ctx.candles, 30)}

LATEST CLOSE: ${ctx.candles.at(-1)?.close ?? ctx.currentPrice}
LIVE SPOT:    ${ctx.currentPrice}`
    : `PRICE DATA: Live spot only — ${ctx.currentPrice} (no candle history yet, HOLD)`;

  return `You are SMC Alpha Executor — an autonomous DeFi trading agent using Smart Money Concepts (SMC) analysis.

CHAIN: Arc Testnet (Circle App Kit spot swaps)
SUPPORTED TOKENS: USDC, EURC, cirBTC
TOKEN MAP: cirBTC = Bitcoin on Arc Testnet. USDC → cirBTC = buying BTC. USDC → EURC = buying Euro.

CURRENT MARKET STATE:
  - Price Pair:   ${ctx.pricePairLabel}
  - Candle Count: ${candleCount} real OHLC bars (30-min each)
  - Live Spot:    ${ctx.currentPrice}

${candleBlock}

WALLET BALANCES:
  - USDC:   ${ctx.balances.USDC}
  - EURC:   ${ctx.balances.EURC}
  - cirBTC: ${ctx.balances.cirBTC}

${positionBlock}

TRADING RULES (each candle above has real O/H/L/C wick data — use it precisely):
1. ENTRY — BTC/USD pair (no open position, requires >= 3 OHLC candles):
   - OrderBlock: cluster of low-close candles before a strong bullish impulse.
     Price has now retraced into that zone.
     patternLow = LOW of the OrderBlock candle. patternHigh = HIGH of the OrderBlock candle.
   - FairValueGap (FVG): candle[N].high < candle[N+2].low — a gap in the 3-candle impulse.
     patternLow = candle[N].high (gap bottom). patternHigh = candle[N+2].low (gap top).
   - LiquiditySweep: a wick LOW pierced below a prior multi-candle swing low, then closed above.
     patternLow = the sweep wick low. patternHigh = the reversal candle's close.
   - If a confirmed bullish pattern → SWAP: fromToken="USDC", toToken="cirBTC".

2. ENTRY — EUR/USD pair (no open position, requires >= 3 candles):
   - Same pattern rules. If bullish → SWAP: fromToken="USDC", toToken="EURC".

3. TAKE PROFIT (open position, currentPrice >= tpPrice OR structure high hit):
   - SWAP held asset back to USDC. patternDetected="TakeProfit".

4. STOP LOSS (open position, currentPrice <= slPrice OR structure low broken):
   - SWAP held asset back to USDC. patternDetected="StopLoss".

5. HOLD — fewer than 3 candles OR no clear SMC setup visible in the OHLC data.
   - patternDetected="None".

RESPONSE FORMAT — return ONLY this JSON, no markdown:
{"action": "SWAP" or "HOLD", "fromToken": "USDC"/"EURC"/"cirBTC", "toToken": "USDC"/"EURC"/"cirBTC", "amountIn": "<number string>", "patternDetected": "OrderBlock"/"FairValueGap"/"LiquiditySweep"/"TakeProfit"/"StopLoss"/"None", "patternLow": <number or null>, "patternHigh": <number or null>, "reasoning": "<max 80 chars>"}`;
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

// ── Safe Fallback ─────────────────────────────────────────────────────────────

function holdDecision(reason: string): SMCDecision {
  return {
    action: 'HOLD',
    fromToken: 'USDC',
    toToken: 'USDC',
    amountIn: '0.00',
    patternDetected: 'None',
    reasoning: reason,
  };
}

// ── JSON Extraction Helper ─────────────────────────────────────────────────────

/**
 * Extracts the first well-formed JSON object from a string.
 * Handles Gemini responses that prefix prose like "Here is the JSON requested:".
 * Falls back to the original string if no braces are found.
 */
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  if (start === -1) return text;

  let end = text.lastIndexOf('}');
  let sliced: string;

  if (end !== -1 && end > start) {
    sliced = text.slice(start, end + 1);
  } else {
    sliced = text.slice(start);
  }

  // Replace raw control characters and newlines with spaces
  sliced = sliced.replace(/[\r\n\t]+/g, ' ').trim();

  // Auto-repair truncated JSON: if missing closing brace, close unescaped quote if needed,
  // strip any trailing comma (e.g. `"patternLow": 64455,` → valid before `}`), then append '}'.
  if (!sliced.endsWith('}')) {
    const quoteCount = (sliced.match(/(?<!\\)"/g) || []).length;
    if (quoteCount % 2 !== 0) {
      sliced += '"';
    }
    // Strip trailing comma/whitespace — e.g. `..., 64455,` → `..., 64455` before closing
    sliced = sliced.replace(/,\s*$/, '');
    sliced += '}';
  }

  return sliced;
}

// ── Main Export ───────────────────────────────────────────────────────────────

/**
 * Calls Gemini Flash with the full SMC context and returns a validated
 * trading decision. Never throws — always returns a HOLD on any failure
 * so the 60-second daemon loop cannot crash.
 */
export async function evaluateSMCStrategy(ctx: SMCContext): Promise<SMCDecision> {
  const systemPrompt = buildSystemPrompt(ctx);

  let rawText: string;
  try {
    rawText = await callGeminiJSON(systemPrompt, {
      currentPrice: ctx.currentPrice,
      candleCount: ctx.candles.length,
      latestCandle: ctx.candles.at(-1) ?? null,
      balances: ctx.balances,
      activePosition: ctx.activePosition,
    });
  } catch (err) {
    const rawMsg = (err as Error).message;
    let cleanMsg = 'Market data evaluation paused. Retrying next cycle.';
    if (rawMsg.includes('429')) {
      cleanMsg = 'Gemini API rate limit reached (429). Retrying next interval with rotated key.';
    } else if (rawMsg.includes('503') || rawMsg.includes('529')) {
      cleanMsg = 'Gemini API overloaded (503/529). Retrying next interval.';
    }
    console.warn('[SMC] Gemini call failed — defaulting to HOLD:', rawMsg.slice(0, 150));
    return holdDecision(cleanMsg);
  }

  try {
    const jsonText = extractJsonObject(rawText);
    const parsed = JSON.parse(jsonText);
    const decision = validateDecision(parsed);
    console.log(`[SMC] ✓ Decision: ${decision.action} | Pattern: ${decision.patternDetected} | ${decision.reasoning.slice(0, 100)}`);
    return decision;
  } catch (parseErr) {
    console.warn('[SMC] JSON parse/validation failed — defaulting to HOLD:', (parseErr as Error).message);
    console.warn('[SMC] Raw Gemini response was:', rawText.slice(0, 300));
    return holdDecision(`JSON parse error: ${(parseErr as Error).message}`);
  }
}

// ── Gemini JSON-mode variant ──────────────────────────────────────────────────

/**
 * Calls Gemini REST API with responseMimeType: "application/json" so the model
 * is forced to return clean JSON without markdown code-fence wrappers.
 * This is critical for reliable JSON.parse() inside the daemon loop.
 */
async function callGeminiJSON(systemPrompt: string, dataPayload: object): Promise<string> {
  // Aggregate all GEMINI_API_KEY* / GEMINI_KEY_* env vars into one pool for rotation
  const envKeys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY2,
    process.env.GEMINI_API_KEY3,
    process.env.GEMINI_API_KEY4,
    process.env.GEMINI_API_KEY5,
    process.env.GEMINI_API_KEY6,
    process.env.GEMINI_KEY_7,
    process.env.GEMINI_KEY_8,
    process.env.GEMINI_KEY_9,
  ];

  const GEMINI_KEYS = envKeys
    .flatMap(v => (v ?? '').split(','))
    .map(k => k.trim())
    .filter(Boolean);

  const GEMINI_MODEL = 'gemini-2.5-flash';

  if (GEMINI_KEYS.length === 0) {
    throw new Error('No Gemini API keys configured. Set GEMINI_API_KEY in ENGINE/.env');
  }

  const fullPrompt = `${systemPrompt}\n\nLIVE DATA PAYLOAD (use these exact values — do not fabricate numbers):\n${JSON.stringify(dataPayload, null, 2)}`;

  const maxAttempts = Math.min(GEMINI_KEYS.length * 2, 6);
  let lastError: Error | null = null;
  let keyIndex = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const apiKey = GEMINI_KEYS[keyIndex % GEMINI_KEYS.length];
    keyIndex++;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90_000);

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: fullPrompt }] }],
            generationConfig: {
              maxOutputTokens: 2048, // Raised from 1024 — BTC context caused truncated JSON at 1024
              temperature: 0.2,  // Low temperature for deterministic trading decisions
              responseMimeType: 'application/json',
            },
          }),
        }
      );
      clearTimeout(timeoutId);

      if (response.ok) {
        const json: any = await response.json();
        const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (!text) throw new Error('Gemini returned an empty response');
        return text;
      }

      const errBody = await response.text().catch(() => '(unreadable)');

      if (response.status === 429 || response.status === 503 || response.status === 529) {
        // Rate-limited or overloaded — rotate key and retry with short backoff
        const isQuota = errBody.includes('RESOURCE_EXHAUSTED') || errBody.includes('quota');
        const errSummary = isQuota ? 'Quota exceeded (429)' : `HTTP ${response.status}`;
        lastError = new Error(`Gemini API ${errSummary}`);
        console.warn(`[SMC/Gemini] Key ${keyIndex} rate-limited (${response.status}) — rotating key...`);
        if (attempt < maxAttempts) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
        continue;
      }

      // Permanent error — don't retry
      throw new Error(`Gemini permanent error HTTP ${response.status}: ${errBody}`);
    } catch (networkErr: any) {
      clearTimeout(timeoutId);
      lastError = networkErr;
      console.warn(`[SMC/Gemini] Network error attempt ${attempt}/${maxAttempts}:`, networkErr.message);
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
  }

  throw lastError ?? new Error('Gemini SMC call failed after all retry attempts');
}
