/**
 * daemon-manager.ts
 *
 * In-memory registry of running SMC Alpha Executor daemon loops.
 * One daemon per user, keyed by lowercased wallet address.
 *
 * WARNING: IN-MEMORY ONLY — does NOT persist across ENGINE process restarts.
 *     On restart all daemon entries are lost; users must re-trigger deploy
 *     from the marketplace UI. This is an acceptable hackathon-demo stopgap.
 *     A persistent daemon manager (Redis/DB-backed, auto-restart on boot)
 *     is a post-hackathon roadmap item.
 *     See AETHEL_LABS_ROADMAP.md, Decisions Log, 2026-07-25.
 */

import { runSMCExecutorCycle } from '../agents/smc_executor_loop';
import { ensureMarketAnalystRunning } from '../reasoning/market_analyst';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DaemonEntry {
  /** Circle-verified wallet address of the user (lowercase) */
  userAddress: string;
  /** Aethel internal user/refId used for Trading Wallet assignment */
  userRefId: string;
  /** Circle Developer-Controlled Trading Wallet address assigned to this user */
  tradingWalletAddress: string;
  /**
   * Circle walletId for the user's dedicated Fee Wallet (Developer-Controlled EOA, 'aethel-fee-wallets' set).
   * Passed at deploy time so deductDaemonTaskFee() signs EIP-3009 payloads with the correct
   * entity-secret-backed key — never the Trading Wallet and never the User-Controlled login wallet.
   */
  feeWalletId?: string;
  /** Loop interval in seconds */
  intervalSeconds: number;
  /** Epoch ms when the daemon was started */
  startedAt: number;
  /** Number of completed cycles since start */
  cycleCount: number;
  /** Epoch ms of the last completed cycle, or null if none yet */
  lastCycleAt: number | null;
  /** Agent ID being run by this daemon loop */
  agentId: string;
  /** NodeJS interval handle — used to clear the loop on stop */
  _intervalHandle: NodeJS.Timeout;
}

export interface DaemonStatus {
  running: boolean;
  userAddress: string;
  userRefId: string;
  tradingWalletAddress: string;
  feeWalletId?: string;
  intervalSeconds: number;
  startedAt: number;
  cycleCount: number;
  lastCycleAt: number | null;
  uptimeSeconds: number;
  agentId: string;
}

export interface StartDaemonResult {
  entry: DaemonEntry;
  alreadyExisted: boolean;
}

// ── Registry ──────────────────────────────────────────────────────────────────

const _daemons = new Map<string, DaemonEntry>();

// ── Internal ──────────────────────────────────────────────────────────────────

function _key(userAddress: string): string {
  return userAddress.toLowerCase();
}

async function _runCycle(entry: DaemonEntry): Promise<void> {
  try {
    await runSMCExecutorCycle({
      userRefId: entry.userRefId,
      feeWalletId: entry.feeWalletId,
      once: false,
      intervalSeconds: entry.intervalSeconds,
    });
    entry.cycleCount++;
    entry.lastCycleAt = Date.now();
  } catch (err) {
    console.error(
      `[DaemonManager] Cycle error for ${entry.userAddress}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start a daemon loop for a user.
 * Idempotent — if a daemon is already running for this address, returns the
 * existing entry without starting a second loop, setting alreadyExisted = true.
 *
 * @param userAddress          Circle-verified wallet address (will be lowercased)
 * @param userRefId            Aethel internal ref/user ID (used for Trading Wallet lookup)
 * @param tradingWalletAddress Pre-assigned Circle Developer-Controlled Wallet address
 * @param intervalSeconds      How often to run the executor cycle (default 60s)
 * @param agentId              Which agent is being run
 * @param feeWalletId          Circle walletId for the user's Fee Wallet (Developer-Controlled EOA,
 *                             'aethel-fee-wallets' set) — threaded directly into deductDaemonTaskFee()
 *                             so no per-cycle wallet lookup is needed
 */
export function startDaemon(
  userAddress: string,
  userRefId: string,
  tradingWalletAddress: string,
  intervalSeconds = 300,
  agentId = 'agent_smc_alpha_executor',
  feeWalletId?: string,
): StartDaemonResult {
  const key = _key(userAddress);

  // Ensure shared Market Analyst is running for this agentId across all users
  ensureMarketAnalystRunning(agentId, intervalSeconds);

  const existing = _daemons.get(key);
  if (existing) {
    console.log(`[DaemonManager] Daemon already running for ${userAddress} — no-op.`);
    return { entry: existing, alreadyExisted: true };
  }

  const entry: DaemonEntry = {
    userAddress: key,
    userRefId,
    tradingWalletAddress,
    feeWalletId,
    intervalSeconds,
    startedAt: Date.now(),
    cycleCount: 0,
    lastCycleAt: null,
    agentId,
    _intervalHandle: setInterval(() => void _runCycle(entry), intervalSeconds * 1000),
  };

  _daemons.set(key, entry);

  // Run the first cycle immediately so the user sees activity right away,
  // without waiting for the first interval to fire.
  void _runCycle(entry);

  console.log(
    `[DaemonManager] Daemon started for ${userAddress} ` +
    `(refId: ${userRefId}, wallet: ${tradingWalletAddress}, interval: ${intervalSeconds}s)`,
  );

  return { entry, alreadyExisted: false };
}

/**
 * Stop a running daemon for a user.
 * No-op if no daemon is registered for this address.
 */
export function stopDaemon(userAddress: string): boolean {
  const key = _key(userAddress);
  const entry = _daemons.get(key);
  if (!entry) {
    console.log(`[DaemonManager] No daemon found for ${userAddress} — nothing to stop.`);
    return false;
  }

  clearInterval(entry._intervalHandle);
  _daemons.delete(key);

  console.log(
    `[DaemonManager] Daemon stopped for ${userAddress} ` +
    `(${entry.cycleCount} cycles completed, uptime: ${Math.round((Date.now() - entry.startedAt) / 1000)}s)`,
  );

  return true;
}

/**
 * Get the current status of a user's daemon.
 * Returns null if no daemon is running for this address.
 */
export function getDaemonStatus(userAddress: string): DaemonStatus | null {
  const key = _key(userAddress);
  const entry = _daemons.get(key);
  if (!entry) return null;

  return {
    running: true,
    userAddress: entry.userAddress,
    userRefId: entry.userRefId,
    tradingWalletAddress: entry.tradingWalletAddress,
    feeWalletId: entry.feeWalletId,
    intervalSeconds: entry.intervalSeconds,
    startedAt: entry.startedAt,
    cycleCount: entry.cycleCount,
    lastCycleAt: entry.lastCycleAt,
    uptimeSeconds: Math.round((Date.now() - entry.startedAt) / 1000),
    agentId: entry.agentId || 'agent_smc_alpha_executor',
  };
}

/**
 * List all currently active daemons.
 */
export function listDaemons(): DaemonStatus[] {
  return Array.from(_daemons.values()).map(entry => ({
    running: true,
    userAddress: entry.userAddress,
    userRefId: entry.userRefId,
    tradingWalletAddress: entry.tradingWalletAddress,
    feeWalletId: entry.feeWalletId,
    intervalSeconds: entry.intervalSeconds,
    startedAt: entry.startedAt,
    cycleCount: entry.cycleCount,
    lastCycleAt: entry.lastCycleAt,
    uptimeSeconds: Math.round((Date.now() - entry.startedAt) / 1000),
    agentId: entry.agentId || 'agent_smc_alpha_executor',
  }));
}
