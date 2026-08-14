/**
 * smc_executor_loop.ts — SMC Alpha Executor Autonomous Daemon
 *
 * Full 3-layer architecture per AETHEL_LABS_ROADMAP.md:
 *   Layer 1: Gemini 2.5 Flash SMC Reasoning (evaluateSMCStrategy)
 *   Layer 2: Spend Policy Gate (checkSpendPolicy / recordSpend)
 *   Layer 3: Circle App Kit Spot Swap Execution (estimateSwap / executeSwap)
 *
 * Market data: Live mainnet prices from CoinGecko (BTC/USD) + Coinbase (EUR/USD)
 * Settlement:  Arc Testnet via Circle App Kit Developer-Controlled Wallets
 * Persistence: ENGINE/data/positions.json (entry price / held asset per user)
 * Fee:         EIP-3009 Gateway nanopayment per cycle (deductDaemonTaskFee)
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { parseAbi, type Address } from 'viem';

import { getOrAssignTradingWallet } from '../lib/trading-wallet';
import { estimateSwap, executeSwap } from '../lib/appkit-swap';
import { checkSpendPolicy, recordSpend } from '../lib/spend-limit-policy';
import { publicClient, USDC_ADDRESS, deductDaemonTaskFee } from '../lib/payment-utils';
import {
  getPosition,
  savePosition,
  clearPosition,
  getPositionSlots,
  getPositionSummary,
  addPositionSlot,
  MAX_POSITION_SLOTS,
  type PositionSlot,
} from '../lib/position-store';
import { type SupportedToken } from '../reasoning/smc';
import { type OHLCCandle } from '../lib/ohlc-feed';
import {
  getLatestSharedDecision,
  runMarketAnalystCycle,
  ensureMarketAnalystRunning,
  type SharedDecision,
} from '../reasoning/market_analyst';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ── Audit Logging ─────────────────────────────────────────────────────────────

const LOG_DIR = path.resolve(__dirname, '../../logs');
const LOG_FILE = path.join(LOG_DIR, 'execution.log');

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function writeAuditLog(entry: Record<string, any>) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${JSON.stringify(entry)}\n`;
  try {
    fs.appendFileSync(LOG_FILE, logLine, 'utf-8');
  } catch (logErr) {
    console.warn('[SMCExecutor] Could not append audit log:', (logErr as Error).message);
  }

  console.log(`\n=================== [AUDIT LOG ENTRY] ===================`);
  console.log(`Timestamp:       ${timestamp}`);
  console.log(`Cycle:           ${entry.cycle}`);
  console.log(`User Ref ID:     ${entry.userRefId}`);
  console.log(`Trading Wallet:  ${entry.tradingWalletAddress}`);
  console.log(`Price Feed:      ${entry.priceFeedPair} = ${entry.currentPrice}`);
  if (entry.activePosition) {
    console.log(`Open Position:   ${entry.activePosition.amount} ${entry.activePosition.heldAsset} @ ${entry.activePosition.entryPrice}`);
  }
  console.log(`SMC Pattern:     ${entry.patternDetected}`);
  console.log(`Signal:          ${entry.signal}`);
  console.log(`Reasoning:       ${entry.reasoning}`);
  console.log(`Task Fee:        ${entry.taskFeeSettled ? `✓ $${entry.taskFeeDisplay} USDC settled` : `⚠ skipped (${entry.taskFeeError ?? 'unknown'})`}`);
  console.log(`Policy Check:    ${entry.policyAllowed ? 'APPROVED' : `REJECTED (${entry.policyReason})`}`);
  if (entry.executed) {
    console.log(`Execution:       SUCCESS`);
    console.log(`Swap:            ${entry.swapFrom} → ${entry.swapTo} (${entry.amountIn} units)`);
    console.log(`Quoted Out:      ${entry.amountOut}`);
    console.log(`Tx Hash:         ${entry.txHash ?? 'N/A (Pending/Simulated)'}`);
  } else {
    console.log(`Execution:       SKIPPED / NO ACTION`);
  }
  console.log(`=========================================================\n`);
}

// ── Live Market Data ──────────────────────────────────────────────────────────

/** Fetches EUR/USD spot rate from Coinbase public API (mainnet). */
async function fetchEURUSDPrice(): Promise<number | null> {
  try {
    // Coinbase EUR/USD spot price — no API key required
    const res = await fetch('https://api.coinbase.com/v2/prices/EUR-USD/spot', {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: any = await res.json();
    const price = parseFloat(data?.data?.amount);
    if (isNaN(price) || price <= 0) throw new Error('Invalid price');
    return price;
  } catch (err) {
    console.warn('[MarketData] Coinbase EUR/USD failed, trying fallback ER-API:', (err as Error).message);

    // Fallback: Open Exchange Rates (no auth needed)
    try {
      const res = await fetch('https://open.er-api.com/v6/latest/USD', {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: any = await res.json();
      if (data?.rates?.EUR) return 1 / data.rates.EUR;
    } catch (err2) {
      console.warn('[MarketData] ER-API fallback also failed:', (err2 as Error).message);
    }
    return null;
  }
}

/** Fetches BTC/USD spot price from CoinGecko public API. */
async function fetchBTCUSDPrice(): Promise<number | null> {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      { signal: AbortSignal.timeout(8_000) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: any = await res.json();
    const price = data?.bitcoin?.usd;
    if (typeof price !== 'number' || price <= 0) throw new Error('Invalid price');
    return price;
  } catch (err) {
    console.warn('[MarketData] CoinGecko BTC/USD failed:', (err as Error).message);

    // Fallback: Coinbase BTC-USD spot
    try {
      const res = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot', {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: any = await res.json();
      const price = parseFloat(data?.data?.amount);
      if (!isNaN(price) && price > 0) return price;
    } catch (err2) {
      console.warn('[MarketData] Coinbase BTC/USD fallback failed:', (err2 as Error).message);
    }
    return null;
  }
}

/**
 * EUR/USD spot-price tick history — used as fallback for EUR/EURC pair only.
 * BTC uses real CoinGecko OHLC candles fetched each cycle (see fetchBTCCandles).
 * EUR OHLC is unavailable from CoinGecko (crypto-only API) — documented limitation.
 */
const eurSpotHistory: number[] = [];
const MAX_EUR_HISTORY = 20;

function appendEurHistory(price: number) {
  eurSpotHistory.push(price);
  if (eurSpotHistory.length > MAX_EUR_HISTORY) {
    eurSpotHistory.shift();
  }
}

// ── Token Balance Reader with Persistent Cache & Throttled Retries ─────────────

const DATA_DIR = path.resolve(__dirname, '../../data');
const BALANCE_CACHE_FILE = path.join(DATA_DIR, 'balance_cache.json');

function loadPersistentBalanceCache(): Record<string, string> {
  try {
    if (fs.existsSync(BALANCE_CACHE_FILE)) {
      const raw = fs.readFileSync(BALANCE_CACHE_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch { /* ignore */ }
  return {};
}

function savePersistentBalanceCache(cache: Record<string, string>): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(BALANCE_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

const persistentBalanceCache = loadPersistentBalanceCache();

async function readTokenBalance(tokenAddress: Address, walletAddress: Address): Promise<bigint> {
  const cacheKey = `${walletAddress.toLowerCase()}:${tokenAddress.toLowerCase()}`;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const balance = await publicClient.readContract({
        address: tokenAddress,
        abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
        functionName: 'balanceOf',
        args: [walletAddress],
      }) as bigint;

      // Update in-memory & file cache on clean read
      persistentBalanceCache[cacheKey] = balance.toString();
      savePersistentBalanceCache(persistentBalanceCache);
      return balance;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const errMsg = lastErr.message;

      // Detect non-deployed contract — "returned no data (\"0x\")" is a permanent failure,
      // not a transient RPC hiccup. Return 0n silently without retrying.
      if (errMsg.includes('returned no data') || errMsg.includes('"0x"')) {
        return 0n;
      }

      if (attempt < 3) {
        await new Promise(res => setTimeout(res, 400 * attempt));
      }
    }
  }

  // Retain last known valid balance if RPC failed on all attempts
  const cachedStr = persistentBalanceCache[cacheKey];
  if (cachedStr !== undefined) {
    const cachedBigInt = BigInt(cachedStr);
    console.warn(`[Balance] RPC rate-limited after 3 attempts — retaining cached: ${cachedStr}`);
    return cachedBigInt;
  }

  console.warn(`[Balance] RPC read failed (no cache) for ${tokenAddress}: ${lastErr?.message?.split('\n')[0]}`);
  return 0n;
}

import { TOKEN_ADDRESSES } from '../lib/dex-router';

// ── Known Token Addresses on Arc Testnet ──────────────────────────────────────
const EURC_ADDRESS = (process.env.EURC_ADDRESS ?? TOKEN_ADDRESSES.EURC.address) as Address;
const CIRBTC_ADDRESS = (process.env.CIRBTC_ADDRESS ?? TOKEN_ADDRESSES.cirBTC.address) as Address;

// ── Decision Execution Tracker (Prevents 60s re-execution of 5-min signals) ───
const _lastExecutedDecisionTimestamps = new Map<string, number>();

// ── Daemon State ──────────────────────────────────────────────────────────────

let cycleCount = 0;
const DAEMON_TASK_FEE_USDC = 0.0001;

interface LoopOptions {
  userRefId: string;
  /** Circle walletId of the Fee Wallet (Developer-Controlled EOA, 'aethel-fee-wallets' set).
   *  Passed from DaemonManager at deploy time. deductDaemonTaskFee() uses it to sign
   *  EIP-3009 server-side with the entity secret — never the Trading Wallet, never the
   *  User-Controlled login wallet. */
  feeWalletId?: string;
  once: boolean;
  intervalSeconds: number;
}

/** Result of a single daemon cycle — surfaced to frontend via DaemonStatus.lastCycleResult */
export interface CycleResult {
  /** Whether a swap was attempted */
  swapAttempted: boolean;
  /** Whether the swap succeeded (only meaningful if swapAttempted=true) */
  swapSucceeded: boolean;
  /** Swap direction, e.g. 'USDC → cirBTC' */
  swapDirection?: string;
  /** Amount sent in the swap */
  amountIn?: string;
  /** Amount received from the swap */
  amountOut?: string;
  /** On-chain transaction hash */
  txHash?: string;
  /** Error message if the swap failed */
  error?: string;
  /** Policy rejection reason if applicable */
  policyRejection?: string;
  /** Timestamp of this result (epoch ms) */
  timestamp: number;
}

// ── Core Cycle ────────────────────────────────────────────────────────────────

export async function runSMCExecutorCycle(options: LoopOptions): Promise<CycleResult> {
  cycleCount++;
  const { userRefId } = options;

  console.log(`\n🤖 [SMC Cycle ${cycleCount}] Starting for user: ${userRefId}`);

  // ── 1. Resolve Trading Wallet ────────────────────────────────────────────

  let tradingWalletAddress = process.env.APP_FEE_RECIPIENT ?? '0x0000000000000000000000000000000000000000';
  let walletId = 'unknown';

  try {
    const tw = await getOrAssignTradingWallet(userRefId);
    tradingWalletAddress = tw.address;
    walletId = tw.id;
    console.log(`[SMC] Trading Wallet: ${tradingWalletAddress}`);
  } catch (err) {
    console.warn(`[SMC] Could not resolve Trading Wallet: ${(err as Error).message} — using fallback address`);
  }

  // ── 2. Read Wallet Balances Sequentially & Guard ─────────────────────────

  const rawUSDC = await readTokenBalance(USDC_ADDRESS, tradingWalletAddress as Address);
  await new Promise(r => setTimeout(r, 150));
  const rawEURC = await readTokenBalance(EURC_ADDRESS, tradingWalletAddress as Address);
  await new Promise(r => setTimeout(r, 150));
  const rawCirBTC = await readTokenBalance(CIRBTC_ADDRESS, tradingWalletAddress as Address);

  const balances = {
    USDC: (Number(rawUSDC) / 1e6).toFixed(6),
    EURC: (Number(rawEURC) / 1e6).toFixed(6),
    cirBTC: (Number(rawCirBTC) / 1e8).toFixed(8),
  };

  const usdcBalanceNum = Number(rawUSDC) / 1e6;
  if (usdcBalanceNum < 0.001) {
    console.log(`[Daemon] Insufficient funds for ${userRefId} (${balances.USDC} USDC). Skipping cycle.`);
    return { swapAttempted: false, swapSucceeded: false, error: `Insufficient funds: ${balances.USDC} USDC`, timestamp: Date.now() };
  }

  console.log(`[SMC] Balances — USDC: ${balances.USDC} | EURC: ${balances.EURC} | cirBTC: ${balances.cirBTC}`);

  // ── 3. Deduct Gateway Nanopayment Task Fee ($0.0001 USDC) from Agent Wallet ─
  // Architecture Enforcement:
  // - Agent Wallet (The Operator): Pays the $0.0001 USDC task fee to Gateway Address.
  // - Trading Wallet (The Vault): Kept strictly isolated — zero task fee leakage from principal.
  const agentWalletAddress = userRefId.startsWith('0x') ? userRefId : `0x${userRefId}`;
  const taskFee = await deductDaemonTaskFee(agentWalletAddress, DAEMON_TASK_FEE_USDC, options.feeWalletId);

  // ── 4. Shared Decision-Engine Architecture (Market Analyst) ───────────────
  // Ensure the shared Market Analyst process is active for 'smc_alpha_executor'
  const intervalSec = options.intervalSeconds || 300;
  ensureMarketAnalystRunning('smc_alpha_executor', intervalSec);

  // Fetch the latest shared decision (must not be older than 2x the analyst interval)
  const maxAgeMs = intervalSec * 2 * 1000;
  let decision = getLatestSharedDecision('smc_alpha_executor', maxAgeMs);

  // If no decision is stored yet (e.g. cold start), run a single analyst cycle immediately
  if (!decision) {
    console.log(`[SMC] Cold start for Market Analyst — triggering immediate analyst evaluation...`);
    decision = await runMarketAnalystCycle('smc_alpha_executor');
  }

  if (!decision) {
    console.warn(`[SMC] Market Analyst decision unavailable for user ${userRefId} — skipping execution.`);
    return { swapAttempted: false, swapSucceeded: false, error: 'Market Analyst decision unavailable', timestamp: Date.now() };
  }

  const ageSec = Math.round((Date.now() - decision.timestamp) / 1000);
  console.log(
    `[SMC] Reusing shared Market Analyst decision (age: ${ageSec}s): ` +
    `Action=${decision.action} | Pattern=${decision.patternDetected} | ` +
    `Pair=${decision.pricePairLabel || 'BTC/USD'} | Price=$${decision.price}`
  );

  const currentPrice = decision.price ?? 64000;
  const onChainCirBTCAmount = (Number(rawCirBTC) / 1e8).toFixed(8);
  const onChainCirBTCHeld = parseFloat(onChainCirBTCAmount);

  // ── 4b. Option C Position Summary & Display ─────────────────────────────
  const posSummary = getPositionSummary(userRefId, currentPrice);

  if (posSummary.usedSlots > 0 && onChainCirBTCHeld > 0) {
    const pnlEmoji = parseFloat(posSummary.pnlPct) >= 0 ? '🟢' : '🔴';
    console.log(
      `\n[Portfolio Position] Holding ${onChainCirBTCAmount} ${posSummary.heldAsset} ` +
      `(Avg Entry: $${posSummary.avgEntryPrice.toLocaleString()} | PnL: ${posSummary.pnlPct}% / $${posSummary.pnlUsd} ${pnlEmoji})`
    );
    posSummary.slots.forEach((s) => {
      console.log(
        `  • Slot ${s.slotNumber}/${MAX_POSITION_SLOTS}: ${s.amount} ${s.heldAsset} @ $${s.entryPrice.toLocaleString()} ` +
        `(TP: $${s.tpPrice?.toLocaleString() ?? 'N/A'} | SL: $${s.slPrice?.toLocaleString() ?? 'N/A'})`
      );
    });
    if (posSummary.availableSlots > 0) {
      console.log(`  • Slots ${posSummary.usedSlots + 1}-${MAX_POSITION_SLOTS}: Available for DCA / New Setups (${posSummary.availableSlots} free)`);
    }

    // ── Check Multi-Slot TP / SL Triggers ─────────────────────────────────
    let exitTriggered = false;
    let exitReason = '';
    let triggeredTarget = 0;

    for (const slot of posSummary.slots) {
      if (typeof slot.slPrice === 'number' && currentPrice <= slot.slPrice) {
        exitTriggered = true;
        exitReason = 'STOP LOSS';
        triggeredTarget = slot.slPrice;
        break;
      }
      if (typeof slot.tpPrice === 'number' && currentPrice >= slot.tpPrice) {
        exitTriggered = true;
        exitReason = 'TAKE PROFIT';
        triggeredTarget = slot.tpPrice;
        break;
      }
    }

    if (exitTriggered) {
      console.log(`\n🚨 [${exitReason} TRIGGERED] Spot $${currentPrice.toLocaleString()} hit target $${triggeredTarget.toLocaleString()} — Exiting all position slots...`);
      console.log(`[${exitReason}] Net PnL: ${posSummary.pnlPct}% / $${posSummary.pnlUsd} | Selling ${onChainCirBTCAmount} ${posSummary.heldAsset} → USDC`);

      try {
        const exitResult = await executeSwap({
          walletAddress: tradingWalletAddress,
          walletId,
          tokenIn: posSummary.heldAsset as 'cirBTC' | 'EURC',
          tokenOut: 'USDC',
          amountIn: onChainCirBTCAmount,
          slippageBps: 200,
        });

        clearPosition(userRefId);
        console.log(`[${exitReason}] ✓ Full exit swap executed! Tx: ${exitResult.txHash} | Out: ${exitResult.amountOut} USDC`);

        writeAuditLog({
          cycle: cycleCount, userRefId, tradingWalletAddress, walletId,
          priceFeedPair: decision.pricePairLabel || 'BTC/USD', currentPrice, balances,
          activePosition: { heldAsset: posSummary.heldAsset, amount: onChainCirBTCAmount, entryPrice: posSummary.avgEntryPrice, enteredAt: Date.now() },
          patternDetected: exitReason, signal: `EXIT_${exitReason.replace(' ', '_')}`,
          reasoning: `${exitReason}: Spot $${currentPrice} breached target $${triggeredTarget}. Net PnL: ${posSummary.pnlPct}%`,
          taskFeeSettled: taskFee.settled, taskFeeDisplay: taskFee.feeDisplay, taskFeeError: taskFee.error ?? null,
          policyAllowed: true, policyReason: '', executed: true,
          swapFrom: posSummary.heldAsset, swapTo: 'USDC', amountIn: onChainCirBTCAmount,
          amountOut: exitResult.amountOut ?? 'N/A', txHash: exitResult.txHash ?? null, executionError: null,
        });

        return {
          swapAttempted: true, swapSucceeded: true,
          swapDirection: `${posSummary.heldAsset} → USDC (${exitReason})`,
          amountIn: onChainCirBTCAmount, amountOut: exitResult.amountOut,
          txHash: exitResult.txHash, timestamp: Date.now(),
        };
      } catch (exitErr) {
        const exitErrMsg = (exitErr as Error).message;
        console.error(`[${exitReason}] ✗ Exit swap failed: ${exitErrMsg}`);
        return {
          swapAttempted: true, swapSucceeded: false,
          swapDirection: `${posSummary.heldAsset} → USDC (${exitReason})`,
          error: exitErrMsg, timestamp: Date.now(),
        };
      }
    }
  } else {
    console.log(`[Active Positions] 0/${MAX_POSITION_SLOTS} Slots Used — 100% Capital in USDC (Awaiting SMC Signal)`);
  }

  // ── 5. Layer 2: Spend Policy Gate ────────────────────────────────────────
  let amountAtomic = 0n;
  let policyAllowed = true;
  let policyReason = '';

  if (decision.action === 'SWAP') {
    const fromToken = decision.fromToken as string;
    const toToken = decision.toToken as string;

    // ── Position Guard: Block new BUY if all 5 slots are full ─────────────
    if (fromToken === 'USDC' && toToken !== 'USDC') {
      if (posSummary.usedSlots >= MAX_POSITION_SLOTS && onChainCirBTCHeld > 0) {
        console.log(
          `\n🛡️ [Position Guard] MAX POSITIONS REACHED: All 5/5 slots full (Holding ${onChainCirBTCAmount} ${toToken} @ Avg $${posSummary.avgEntryPrice.toLocaleString()}). ` +
          `Awaiting TP/SL exit before opening new slots.`
        );

        writeAuditLog({
          cycle: cycleCount, userRefId, tradingWalletAddress, walletId,
          priceFeedPair: decision.pricePairLabel || 'BTC/USD', currentPrice, balances,
          activePosition: { heldAsset: toToken, amount: onChainCirBTCAmount, entryPrice: posSummary.avgEntryPrice, enteredAt: Date.now() },
          patternDetected: decision.patternDetected, signal: 'BLOCKED_MAX_SLOTS',
          reasoning: `Position guard: max 5/5 slots full (Holding ${onChainCirBTCAmount} ${toToken} @ Avg $${posSummary.avgEntryPrice}). Awaiting TP/SL exit.`,
          taskFeeSettled: taskFee.settled, taskFeeDisplay: taskFee.feeDisplay, taskFeeError: taskFee.error ?? null,
          policyAllowed: false, policyReason: 'Position Guard: max 5 position slots filled',
          executed: false, swapFrom: fromToken, swapTo: toToken, amountIn: decision.amountIn,
          amountOut: 'N/A', txHash: null, executionError: null,
        });

        return {
          swapAttempted: false, swapSucceeded: false,
          policyRejection: `Position Guard: max 5/5 slots full (${onChainCirBTCAmount} ${toToken})`,
          timestamp: Date.now(),
        };
      }
    }

    // ── Check if this exact 5-minute decision was already executed for this user ──
    const lastExecutedTs = _lastExecutedDecisionTimestamps.get(userRefId) || 0;
    if (decision.timestamp && decision.timestamp === lastExecutedTs) {
      console.log(
        `[SMC] Market Analyst decision (${decision.patternDetected} @ ${decision.timestamp}) was already executed for ${userRefId}. ` +
        `Skipping re-execution — strictly monitoring active position for TP/SL.`
      );

      writeAuditLog({
        cycle: cycleCount, userRefId, tradingWalletAddress, walletId,
        priceFeedPair: decision.pricePairLabel || 'BTC/USD', currentPrice, balances,
        activePosition: posSummary.usedSlots > 0 ? { heldAsset: posSummary.heldAsset, amount: onChainCirBTCAmount, entryPrice: posSummary.avgEntryPrice, enteredAt: Date.now() } : null,
        patternDetected: decision.patternDetected, signal: 'SIGNAL_ALREADY_EXECUTED',
        reasoning: `Decision from timestamp ${decision.timestamp} already executed. Awaiting next 5-min market analyst cycle or TP/SL hit.`,
        taskFeeSettled: taskFee.settled, taskFeeDisplay: taskFee.feeDisplay, taskFeeError: taskFee.error ?? null,
        policyAllowed: false, policyReason: 'Decision already executed in current interval',
        executed: false, swapFrom: fromToken, swapTo: toToken, amountIn: decision.amountIn,
        amountOut: 'N/A', txHash: null, executionError: null,
      });

      return {
        swapAttempted: false, swapSucceeded: false,
        policyRejection: 'Signal already executed in current interval',
        timestamp: Date.now(),
      };
    }

    // Position Sizing: 5% of Trading Wallet USDC Balance (min $1.00 USDC)
    if (decision.fromToken === 'USDC') {
      const TRADE_ALLOCATION_PCT = 0.05;
      const MIN_TRADE_USDC = 1.0; // Circle App Kit minimum
      const calcSize = usdcBalanceNum * TRADE_ALLOCATION_PCT;
      const positionSizeStr = Math.max(calcSize, MIN_TRADE_USDC).toFixed(6);
      decision.amountIn = positionSizeStr;
      console.log(`[SMC] Position Sizing: 5% of Trading Wallet (${usdcBalanceNum.toFixed(2)} USDC) = ${positionSizeStr} USDC (min $${MIN_TRADE_USDC})`);
    }

    const parsedAmount = parseFloat(decision.amountIn ?? '0');
    amountAtomic = !isNaN(parsedAmount) && parsedAmount > 0 ? BigInt(Math.round(parsedAmount * 1e6)) : 0n;

    const policyResult = checkSpendPolicy({
      userAddress: tradingWalletAddress,
      amountAtomic,
      // No targetAddress — Circle App Kit routes swaps through its own internal DEX,
      // not through the Marketplace contract. Passing MARKETPLACE_ADDRESS here was
      // causing silent policy rejection on every swap attempt.
    });
    policyAllowed = policyResult.allowed;
    policyReason = policyResult.reason ?? '';

    if (!policyAllowed) {
      console.warn(`[SMC] Layer 2 Policy REJECTED: ${policyReason}`);
    } else {
      console.log(`[SMC] Layer 2 Policy: APPROVED`);
    }
  }

  // ── 8. Layer 3: Circle App Kit Swap ──────────────────────────────────────

  let executed = false;
  let txHash: string | undefined;
  let amountOut: string | undefined;
  let executionError: string | undefined;

  if (decision.action === 'SWAP' && policyAllowed) {
    const fromToken = decision.fromToken as 'USDC' | 'EURC' | 'cirBTC';
    const toToken = decision.toToken as 'USDC' | 'EURC' | 'cirBTC';

    try {
      const rawFrom = fromToken === 'cirBTC' ? rawCirBTC
        : fromToken === 'EURC' ? rawEURC
        : rawUSDC;
      const fromDecimals = fromToken === 'cirBTC' ? 1e8 : 1e6;
      const fromBalance = Number(rawFrom) / fromDecimals;
      const amountInNum = parseFloat(decision.amountIn);

      if (fromBalance < amountInNum) {
        throw new Error(
          `Insufficient ${fromToken} balance: ${fromBalance.toFixed(6)} available, ${decision.amountIn} required. Fund the Trading Wallet to enable autonomous swaps.`
        );
      }

      console.log(`[SMC] Requesting quote: ${decision.amountIn} ${fromToken} → ${toToken}...`);
      const quote = await estimateSwap({
        walletAddress: tradingWalletAddress,
        tokenIn: fromToken,
        tokenOut: toToken,
        amountIn: decision.amountIn,
      });
      amountOut = quote.amountOut;
      console.log(`[SMC] Quote: ${decision.amountIn} ${fromToken} → ${quote.amountOut} ${toToken} (rate: ${quote.effectiveRate})`);

      console.log(`[SMC] Executing swap via Circle App Kit...`);
      const execResult = await executeSwap({
        walletAddress: tradingWalletAddress,
        tokenIn: fromToken,
        tokenOut: toToken,
        amountIn: decision.amountIn,
        slippageBps: 75,
      });

      txHash = execResult.txHash;
      amountOut = execResult.amountOut ?? amountOut;
      executed = true;

      // Mark this decision timestamp as executed so subsequent 60s cycles skip re-buying
      if (decision.timestamp) {
        _lastExecutedDecisionTimestamps.set(userRefId, decision.timestamp);
      }

      console.log(`[SMC] ✓ Swap executed! Tx: ${txHash} | Out: ${amountOut} ${toToken}`);

      recordSpend({
        userAddress: tradingWalletAddress,
        amountAtomic,
        targetAddress: process.env.MARKETPLACE_ADDRESS ?? '0x0000000000000000000000000000000000000000',
      });

      // ── Update position store ───────────────────────────────────────────
      if (toToken !== 'USDC') {
        // Re-read on-chain balance after swap to get real total held amount
        let totalHeldAmount: string;
        try {
          await new Promise(r => setTimeout(r, 2000)); // Brief wait for chain state
          const freshRawBal = await readTokenBalance(CIRBTC_ADDRESS, tradingWalletAddress as Address);
          totalHeldAmount = (Number(freshRawBal) / 1e8).toFixed(8);
          console.log(`[SMC] Post-swap on-chain ${toToken} balance: ${totalHeldAmount}`);
        } catch {
          totalHeldAmount = amountOut ?? decision.amountIn;
        }

        // Structure-Based SL: Gemini decision.patternLow (exact pattern candle low) > candle window fallback > 0.995 fallback
        const windowLow = currentPrice * 0.995;

        let slPrice: number;
        if (typeof decision.patternLow === 'number' && !isNaN(decision.patternLow) && decision.patternLow < currentPrice) {
          slPrice = parseFloat(decision.patternLow.toFixed(6));
        } else if (windowLow < currentPrice) {
          slPrice = parseFloat(windowLow.toFixed(6));
        } else {
          slPrice = parseFloat((currentPrice * 0.995).toFixed(6));
        }

        // Structure-Based TP: 1:2 Risk-to-Reward ratio (default RR = 2.0)
        const DEFAULT_RR_RATIO = 2.0;
        const riskDistance = currentPrice - slPrice;
        const tpPrice = parseFloat((currentPrice + (riskDistance * DEFAULT_RR_RATIO)).toFixed(6));

        const addResult = addPositionSlot(userRefId, {
          heldAsset: toToken,
          entryPrice: currentPrice,
          amount: amountOut ?? decision.amountIn,
          enteredAt: Date.now(),
          tpPrice,
          slPrice,
          txHash,
        });

        console.log(`[SMC] Pattern Boundaries — Gemini Pattern Low: ${decision.patternLow ?? 'N/A'}, High: ${decision.patternHigh ?? 'N/A'}`);
        console.log(`[SMC] Structure Risk Parameters — Entry: $${currentPrice} | SL (Pattern Low): $${slPrice} (Risk: $${riskDistance.toFixed(2)}) | TP (1:2 R:R): $${tpPrice}`);
        console.log(`[SMC] Slot #${addResult.slotNumber ?? 1}/5 Saved: ${amountOut ?? decision.amountIn} ${toToken} @ $${currentPrice} (TP: $${tpPrice}, SL: $${slPrice})`);
      } else {
        clearPosition(userRefId);
        console.log(`[SMC] Position cleared (exit to USDC)`);
      }
    } catch (err) {
      executionError = (err as Error).message;
      console.error(`[SMC] Swap execution failed: ${executionError}`);
      console.error(`[SMC] Swap failure details — Wallet: ${tradingWalletAddress} | From: ${fromToken} | To: ${toToken} | Amount: ${decision.amountIn}`);
    }
  }

  // ── 9. Audit Log ─────────────────────────────────────────────────────────

  writeAuditLog({
    cycle: cycleCount,
    userRefId,
    tradingWalletAddress,
    walletId,
    priceFeedPair: decision.pricePairLabel || 'BTC/USD',
    currentPrice,
    balances,
    activePosition: posSummary.usedSlots > 0 ? { heldAsset: posSummary.heldAsset, amount: onChainCirBTCAmount, entryPrice: posSummary.avgEntryPrice, enteredAt: Date.now() } : null,
    patternDetected: decision.patternDetected,
    signal: decision.action,
    reasoning: decision.reasoning,
    taskFeeSettled: taskFee.settled,
    taskFeeDisplay: taskFee.feeDisplay,
    taskFeeError: taskFee.error ?? null,
    policyAllowed,
    policyReason,
    executed,
    swapFrom: decision.fromToken,
    swapTo: decision.toToken,
    amountIn: decision.amountIn,
    amountOut: amountOut ?? 'N/A',
    txHash: txHash ?? null,
    executionError: executionError ?? null,
  });

  // ── 10. Return execution result for daemon-manager to surface to frontend ──
  return {
    swapAttempted: decision.action === 'SWAP' && policyAllowed,
    swapSucceeded: executed,
    swapDirection: decision.action === 'SWAP' ? `${decision.fromToken} → ${decision.toToken}` : undefined,
    amountIn: decision.action === 'SWAP' ? decision.amountIn : undefined,
    amountOut: amountOut ?? undefined,
    txHash: txHash ?? undefined,
    error: executionError ?? ((!policyAllowed && decision.action === 'SWAP') ? undefined : undefined),
    policyRejection: (!policyAllowed && decision.action === 'SWAP') ? policyReason : undefined,
    timestamp: Date.now(),
  };
}

// ── CLI Driver ────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  let intervalSeconds = 300;
  let userRefId = 'user_demo_0x1';

  for (const arg of args) {
    if (arg.startsWith('--interval=')) {
      const val = parseInt(arg.split('=')[1]);
      if (!isNaN(val) && val > 0) intervalSeconds = val;
    }
    if (arg.startsWith('--user=')) {
      userRefId = arg.split('=')[1];
    }
  }

  console.log(`\n🤖 Æthel SMC Alpha Executor — Autonomous Loop`);
  console.log(`User Ref ID:       ${userRefId}`);
  console.log(`Mode:              ${once ? 'Single Pass (--once)' : `Daemon Loop (${intervalSeconds}s interval)`}`);
  console.log(`Layer 1:           Gemini 2.5 Flash — SMC Reasoning (responseMimeType: application/json)`);
  console.log(`Layer 2:           Circle Spend Policy Gate`);
  console.log(`Layer 3:           Circle App Kit — Arc Testnet Spot Swap`);
  console.log(`Market Data:       Live mainnet prices (Coinbase + CoinGecko)`);
  console.log(`Settlement Chain:  Arc Testnet (Circle Developer-Controlled Wallets)`);
  console.log(`Position Store:    ENGINE/data/positions.json`);
  console.log(`Audit Log:         ${LOG_FILE}\n`);

  // First cycle
  try {
    await runSMCExecutorCycle({ userRefId, once, intervalSeconds });
  } catch (err) {
    console.error(`[SMC] Unhandled error in cycle 1:`, (err as Error).message);
  }

  if (!once) {
    setInterval(async () => {
      try {
        await runSMCExecutorCycle({ userRefId, once: false, intervalSeconds });
      } catch (err) {
        // Catch all — the 60s loop must never crash
        console.error(`[SMC] Unhandled error in daemon cycle ${cycleCount + 1}:`, (err as Error).message);
      }
    }, intervalSeconds * 1000);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[SMC] Fatal startup error:', err);
    process.exit(1);
  });
}
