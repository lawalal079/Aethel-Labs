/**
 * TODO: STOPGAP SPEND LIMIT POLICY MODULE
 * 
 * IMPORTANT: This runtime policy enforcement module is a temporary stopgap
 * while Circle CLI's native wallet-layer policy (`circle wallet limit`) is mainnet-only.
 * 
 * Once Circle extends native spending policies to Arc Testnet, this module SHOULD BE
 * REMOVED / SWAPPED OUT in favor of native wallet-layer enforced policies.
 * 
 * Architecture & Governance Features:
 * - Hard-stops (blocks execution) before any transaction/task dispatch if policy limits are exceeded.
 * - Enforces per-transaction, rolling daily, weekly, and monthly USDC spending limits.
 * - Enforces allowlists and blocklists per wallet/user.
 * - Accounts for settlement lag by recording pending/unsettled spends alongside settled transactions.
 */

export interface WalletSpendPolicy {
  userAddress: string;
  perTxLimitAtomic: bigint;     // Max atomic USDC units per single transaction (e.g. 5_000_000n = 5.00 USDC)
  dailyLimitAtomic: bigint;     // Max atomic USDC units in rolling 24-hour window
  weeklyLimitAtomic: bigint;    // Max atomic USDC units in rolling 7-day window
  monthlyLimitAtomic: bigint;   // Max atomic USDC units in rolling 30-day window
  allowlist?: string[];         // Allowed target contract / agent addresses (empty = all allowed)
  blocklist?: string[];         // Explicitly blocked target addresses
}

export interface SpendRecord {
  userAddress: string;
  amountAtomic: bigint;
  targetAddress: string;
  timestamp: number;
}

// ── Default Policy Configuration ──────────────────────────────────────────────
// Default limits per user wallet:
// Per-Tx: 5.00 USDC (5_000_000 atomic units)
// Daily: 20.00 USDC (20_000_000 atomic units)
// Weekly: 100.00 USDC (100_000_000 atomic units)
// Monthly: 300.00 USDC (300_000_000 atomic units)
const DEFAULT_PER_TX_LIMIT = 5_000_000n;
const DEFAULT_DAILY_LIMIT = 20_000_000n;
const DEFAULT_WEEKLY_LIMIT = 100_000_000n;
const DEFAULT_MONTHLY_LIMIT = 300_000_000n;

// In-memory policy overrides per user
const userPolicies = new Map<string, WalletSpendPolicy>();

// In-memory ledger of spend transactions per user
const spendLedger: SpendRecord[] = [];

/**
 * Gets or initializes the spending policy for a user address.
 */
export function getWalletPolicy(userAddress: string): WalletSpendPolicy {
  const addr = userAddress.toLowerCase();
  const existing = userPolicies.get(addr);
  if (existing) return existing;

  const defaultPolicy: WalletSpendPolicy = {
    userAddress: addr,
    perTxLimitAtomic: DEFAULT_PER_TX_LIMIT,
    dailyLimitAtomic: DEFAULT_DAILY_LIMIT,
    weeklyLimitAtomic: DEFAULT_WEEKLY_LIMIT,
    monthlyLimitAtomic: DEFAULT_MONTHLY_LIMIT,
    allowlist: [],
    blocklist: [],
  };
  userPolicies.set(addr, defaultPolicy);
  return defaultPolicy;
}

/**
 * Sets or updates custom spending policy for a user address.
 */
export function setWalletPolicy(userAddress: string, policy: Partial<WalletSpendPolicy>): WalletSpendPolicy {
  const addr = userAddress.toLowerCase();
  const current = getWalletPolicy(addr);
  const updated: WalletSpendPolicy = {
    ...current,
    ...policy,
    userAddress: addr,
  };
  userPolicies.set(addr, updated);
  return updated;
}

export interface PolicyVerificationResult {
  allowed: boolean;
  reason?: string;
  perTxLimitAtomic: bigint;
  dailyRemainingAtomic: bigint;
  weeklyRemainingAtomic: bigint;
  monthlyRemainingAtomic: bigint;
}

/**
 * Verifies if a proposed transaction complies with the user's spend policy.
 * THIS HARD-STOPS EXECUTION IF ANY LIMIT IS BREACHED OR TARGET IS BLOCKED.
 */
export function checkSpendPolicy(params: {
  userAddress: string;
  amountAtomic: bigint;
  targetAddress?: string;
}): PolicyVerificationResult {
  const addr = params.userAddress.toLowerCase();
  const target = (params.targetAddress ?? '').toLowerCase();
  const amount = params.amountAtomic;
  const policy = getWalletPolicy(addr);
  const now = Date.now();

  const DAY_MS = 24 * 60 * 60 * 1000;
  const WEEK_MS = 7 * DAY_MS;
  const MONTH_MS = 30 * DAY_MS;

  // 1. Check Allowlist & Blocklist
  if (target) {
    if (policy.blocklist && policy.blocklist.length > 0) {
      if (policy.blocklist.map(b => b.toLowerCase()).includes(target)) {
        return {
          allowed: false,
          reason: `Target address/agent '${target}' is explicitly on your policy blocklist.`,
          perTxLimitAtomic: policy.perTxLimitAtomic,
          dailyRemainingAtomic: 0n,
          weeklyRemainingAtomic: 0n,
          monthlyRemainingAtomic: 0n,
        };
      }
    }

    if (policy.allowlist && policy.allowlist.length > 0) {
      if (!policy.allowlist.map(a => a.toLowerCase()).includes(target)) {
        return {
          allowed: false,
          reason: `Target address/agent '${target}' is not in your policy allowlist.`,
          perTxLimitAtomic: policy.perTxLimitAtomic,
          dailyRemainingAtomic: 0n,
          weeklyRemainingAtomic: 0n,
          monthlyRemainingAtomic: 0n,
        };
      }
    }
  }

  // 2. Check Per-Transaction Limit
  if (amount > policy.perTxLimitAtomic) {
    const amountUSDC = (Number(amount) / 1e6).toFixed(4);
    const limitUSDC = (Number(policy.perTxLimitAtomic) / 1e6).toFixed(4);
    return {
      allowed: false,
      reason: `Transaction amount (${amountUSDC} USDC) exceeds per-transaction policy limit (${limitUSDC} USDC).`,
      perTxLimitAtomic: policy.perTxLimitAtomic,
      dailyRemainingAtomic: 0n,
      weeklyRemainingAtomic: 0n,
      monthlyRemainingAtomic: 0n,
    };
  }

  // 3. Compute Historical Spend across rolling time windows (accounting for settlement lag)
  const userSpends = spendLedger.filter(s => s.userAddress.toLowerCase() === addr);

  const dailySpent = userSpends
    .filter(s => now - s.timestamp <= DAY_MS)
    .reduce((sum, s) => sum + s.amountAtomic, 0n);

  const weeklySpent = userSpends
    .filter(s => now - s.timestamp <= WEEK_MS)
    .reduce((sum, s) => sum + s.amountAtomic, 0n);

  const monthlySpent = userSpends
    .filter(s => now - s.timestamp <= MONTH_MS)
    .reduce((sum, s) => sum + s.amountAtomic, 0n);

  const dailyRemaining = policy.dailyLimitAtomic > dailySpent ? policy.dailyLimitAtomic - dailySpent : 0n;
  const weeklyRemaining = policy.weeklyLimitAtomic > weeklySpent ? policy.weeklyLimitAtomic - weeklySpent : 0n;
  const monthlyRemaining = policy.monthlyLimitAtomic > monthlySpent ? policy.monthlyLimitAtomic - monthlySpent : 0n;

  // 4. Check Rolling Time Window Limits
  if (amount > dailyRemaining) {
    const reqUSDC = (Number(amount) / 1e6).toFixed(4);
    const remUSDC = (Number(dailyRemaining) / 1e6).toFixed(4);
    return {
      allowed: false,
      reason: `Daily spending limit reached. Requested: ${reqUSDC} USDC, Remaining in 24h window: ${remUSDC} USDC.`,
      perTxLimitAtomic: policy.perTxLimitAtomic,
      dailyRemainingAtomic: dailyRemaining,
      weeklyRemainingAtomic: weeklyRemaining,
      monthlyRemainingAtomic: monthlyRemaining,
    };
  }

  if (amount > weeklyRemaining) {
    const reqUSDC = (Number(amount) / 1e6).toFixed(4);
    const remUSDC = (Number(weeklyRemaining) / 1e6).toFixed(4);
    return {
      allowed: false,
      reason: `Weekly spending limit reached. Requested: ${reqUSDC} USDC, Remaining in 7-day window: ${remUSDC} USDC.`,
      perTxLimitAtomic: policy.perTxLimitAtomic,
      dailyRemainingAtomic: dailyRemaining,
      weeklyRemainingAtomic: weeklyRemaining,
      monthlyRemainingAtomic: monthlyRemaining,
    };
  }

  if (amount > monthlyRemaining) {
    const reqUSDC = (Number(amount) / 1e6).toFixed(4);
    const remUSDC = (Number(monthlyRemaining) / 1e6).toFixed(4);
    return {
      allowed: false,
      reason: `Monthly spending limit reached. Requested: ${reqUSDC} USDC, Remaining in 30-day window: ${remUSDC} USDC.`,
      perTxLimitAtomic: policy.perTxLimitAtomic,
      dailyRemainingAtomic: dailyRemaining,
      weeklyRemainingAtomic: weeklyRemaining,
      monthlyRemainingAtomic: monthlyRemaining,
    };
  }

  return {
    allowed: true,
    perTxLimitAtomic: policy.perTxLimitAtomic,
    dailyRemainingAtomic: dailyRemaining - amount,
    weeklyRemainingAtomic: weeklyRemaining - amount,
    monthlyRemainingAtomic: monthlyRemaining - amount,
  };
}

/**
 * Records an authorized transaction in the spend ledger.
 */
export function recordSpend(params: {
  userAddress: string;
  amountAtomic: bigint;
  targetAddress: string;
}): void {
  spendLedger.push({
    userAddress: params.userAddress.toLowerCase(),
    amountAtomic: params.amountAtomic,
    targetAddress: params.targetAddress.toLowerCase(),
    timestamp: Date.now(),
  });
}
