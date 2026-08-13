/**
 * dispatcher.ts
 *
 * Æthel Engine — Agent Dispatch Service
 *
 * Migration to Circle Gateway (Nanopayments):
 *   - Light Agents: Off-chain execution first, withheld result, EIP-3009 payment signature settled via POST /dispatch/settle.
 *   - Heavy Agents: Estimated worst-case cost, EIP-3009 lock payment signature settled immediately, background execution, refund on completion.
 */

import 'dotenv/config';
import * as path from 'path';
// Fallback path-based load if started from the project root instead of the ENGINE subdirectory
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
import * as http from 'http';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { getAgentRegistryEntry, computeResourceFee, estimateTokenCount, verifyUserLicense, publicClient } from '../lib/payment-utils';
import { verifyRequestAuth } from '../lib/auth-utils';
import { checkSpendPolicy, recordSpend } from '../lib/spend-limit-policy';
import { recordTransaction, getUserTransactions, getAllTransactions } from '../lib/transaction-store';
import { saveRating, getAgentRatingStats, getAllRatings } from '../lib/rating-store';
import { type Hash, type Address, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ethers } from 'ethers';
import { agentRegistry, AgentConfiguration, userSessions } from '../agents';
import { getChatHistory, saveChatMessage } from '../agents/utils';
import { startDaemon, stopDaemon, getDaemonStatus, listDaemons } from '../lib/daemon-manager';
import { getOrAssignTradingWallet, getTradingWalletIfExists, withdrawFromTradingWallet, getOrAssignFeeWallet, getFeeWalletIfExists, withdrawFromFeeWallet, getCircleClient } from '../lib/trading-wallet';
import { getLatestSharedDecision } from '../reasoning/market_analyst';
import { getPosition } from '../lib/position-store';
const { BatchFacilitatorClient } = require('@circle-fin/x402-batching/server');

// ── Config ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '4000', 10);
const RPC_URL = process.env.RPC_URL ?? 'https://rpc.testnet.arc.network';

// Load SDK client configs dynamically to prevent module resolution compile errors under "node" resolution
const { CHAIN_CONFIGS } = require('@circle-fin/x402-batching/client');
const arcConfig = CHAIN_CONFIGS.arcTestnet;
const GATEWAY_WALLET_ADDRESS = arcConfig.gatewayWallet;
const USDC_ADDRESS_ARC = arcConfig.usdc;

const GATEWAY_FACILITATOR_URL = process.env.GATEWAY_FACILITATOR_URL || 'https://gateway-api-testnet.circle.com';

const ARC_DOMAIN       = 26;
const GATEWAY_WALLET   = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
const GATEWAY_MINTER   = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B';
const USDC_ARC         = '0x3600000000000000000000000000000000000000';

function padAddress(addr: string): `0x${string}` {
  if (!addr) return '0x0000000000000000000000000000000000000000000000000000000000000000';
  const stripped = addr.startsWith('0x') ? addr.slice(2) : addr;
  return `0x${stripped.padStart(64, '0')}` as `0x${string}`;
}

function cleanTransferSpec(rawSpec: any, depositorAddr: string, recipientAddr?: string) {
  const dep = padAddress(depositorAddr);
  const rec = padAddress(recipientAddr || depositorAddr);
  return {
    version: Number(rawSpec.version ?? 1),
    sourceDomain: Number(rawSpec.sourceDomain ?? ARC_DOMAIN),
    destinationDomain: Number(rawSpec.destinationDomain ?? ARC_DOMAIN),
    sourceContract: padAddress(rawSpec.sourceContract || GATEWAY_WALLET),
    destinationContract: padAddress(rawSpec.destinationContract || GATEWAY_MINTER),
    sourceToken: padAddress(rawSpec.sourceToken || USDC_ARC),
    destinationToken: padAddress(rawSpec.destinationToken || USDC_ARC),
    sourceDepositor: dep,
    destinationRecipient: rec,
    sourceSigner: dep,
    destinationCaller: padAddress(rawSpec.destinationCaller || '0'),
    value: rawSpec.value?.toString() || '0',
    salt: padAddress(rawSpec.salt || crypto.randomBytes(32).toString('hex')),
    hookData: (rawSpec.hookData || '0x') as `0x${string}`,
  };
}

const _PRIVATE_KEY_RAW = process.env.PRIVATE_KEY;
if (!_PRIVATE_KEY_RAW) {
  console.error('[FATAL] PRIVATE_KEY is not set in .env. Aborting.');
  process.exit(1);
}
const formattedPrivateKey = _PRIVATE_KEY_RAW.startsWith('0x') ? _PRIVATE_KEY_RAW : `0x${_PRIVATE_KEY_RAW}`;

const ethersProvider = new ethers.JsonRpcProvider(RPC_URL);
const ethersWallet = new ethers.Wallet(formattedPrivateKey, ethersProvider);

const ENGINE_WALLET_ADDRESS = process.env.ENGINE_WALLET_ADDRESS || ethersWallet.address;

// Initialize Circle Gateway Facilitator Client
const facilitator = new BatchFacilitatorClient({
  url: GATEWAY_FACILITATOR_URL,
});

// ── Test-mode guard ───────────────────────────────────────────────────────────
const MOCK_AUTH_ENABLED =
  process.env.ALLOW_MOCK_AUTH === 'true' &&
  (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development' || !process.env.NODE_ENV);

if (MOCK_AUTH_ENABLED) {
  console.warn('[dispatcher] ⚠️  MOCK_AUTH_ENABLED — integration-test mode active. NEVER run this in production.');
}

// ── Process Crash Protection ───────────────────────────────────────────────────
process.on('unhandledRejection', (reason: unknown) => {
  console.error('[dispatcher] ⚠️  Unhandled Promise Rejection (process preserved):', reason);
});

process.on('uncaughtException', (err: Error, origin: string) => {
  console.error(`[dispatcher] ⚠️  Uncaught Exception (${origin}) (process preserved):`, err.message, err.stack);
});

// Mock balances and failures for integration testing under ALLOW_MOCK_AUTH
const mockBalances = new Map<string, bigint>();
mockBalances.set('0x1111111111111111111111111111111111111111', 5000n);
mockBalances.set('0x2222222222222222222222222222222222222222', 5000n);
mockBalances.set('0x3333333333333333333333333333333333333333', 5000n);
mockBalances.set('0x4444444444444444444444444444444444444444', 1000n);

const mockFailures = new Set<string>();

// Helper to check user balance (USDC balanceOf for Circle Agent Wallet)
async function checkUserBalance(userAddress: string): Promise<bigint> {
  if (MOCK_AUTH_ENABLED) {
    return mockBalances.get(userAddress.toLowerCase()) ?? 5000n;
  }
  try {
    const balance = await publicClient.readContract({
      address: USDC_ADDRESS_ARC as Address,
      abi: parseAbi(['function balanceOf(address account) view returns (uint256)']),
      functionName: 'balanceOf',
      args: [userAddress as Address],
    }) as bigint;
    return balance;
  } catch (err: any) {
    console.error(`[dispatcher] Failed to fetch USDC balanceOf for ${userAddress}:`, err.message);
    throw err;
  }
}

// ── In-Memory & File-based Execution Stores ───────────────────────────────────

interface PendingJob {
  jobId: string;
  buyerAddress: string;
  userId: string;        // Verified auth identity (Privy DID or Circle wallet address)
  agentId: string;
  actualCostAtomic: string;
  result: string;
  logs: string[];
  timestamp: number;
  expiresAt: number;
  settled?: boolean;
  settleTx?: string;
}

const PENDING_JOBS_FILE = path.resolve(process.cwd(), 'src/data/pending_jobs.json');

function ensureDataDir() {
  const dir = path.dirname(PENDING_JOBS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadPendingJobs(): Map<string, PendingJob> {
  ensureDataDir();
  if (!fs.existsSync(PENDING_JOBS_FILE)) {
    return new Map();
  }
  try {
    const raw = fs.readFileSync(PENDING_JOBS_FILE, 'utf8');
    const list: PendingJob[] = JSON.parse(raw);
    const map = new Map<string, PendingJob>();
    const now = Date.now();
    for (const job of list) {
      if (job.settled) {
        console.log(`[pending-jobs] Cleaned up crash-settled job on boot: ${job.jobId}`);
        continue;
      }
      if (job.expiresAt <= now) {
        console.log(`[pending-jobs] Discarded expired job on boot: ${job.jobId}`);
        continue;
      }
      map.set(job.jobId, job);
    }
    return map;
  } catch (err) {
    console.error(`[pending-jobs] Failed to load pending jobs:`, err);
    return new Map();
  }
}

function savePendingJobs(map: Map<string, PendingJob>) {
  ensureDataDir();
  try {
    const list = Array.from(map.values());
    fs.writeFileSync(PENDING_JOBS_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {
    console.error(`[pending-jobs] Failed to save pending jobs:`, err);
  }
}

const pendingJobs = loadPendingJobs();

// Periodic sweep of expired jobs
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, job] of pendingJobs.entries()) {
    if (job.expiresAt <= now) {
      pendingJobs.delete(id);
      changed = true;
      console.log(`[pending-jobs] Cleaned up expired job: ${id}`);
    }
  }
  if (changed) {
    savePendingJobs(pendingJobs);
  }
}, 30 * 1000);

interface ExecutionState {
  txHash: string;
  agentId: string;
  agentTitle: string;
  intent: string;
  status: 'Running' | 'Success' | 'Failed';
  logs: string[];
  result?: string;
  error?: string;
  lockedAtomicUnits: bigint;
  actualAtomicUnits?: bigint;
  startedAt: number;
}

const activeExecutions = new Map<string, ExecutionState>();
const userDispatchQueues = new Map<string, Promise<any>>();

// ── Types ─────────────────────────────────────────────────────────────────────

interface DispatchRequest {
  intent: string;
  agentType: string;
  buyerAddress?: string;
  maxTaskBudget?: string | number;
  userId?: string;
  paymentPayload?: any; // Required for Heavy Agent dispatch
}

interface DispatchResponse {
  success: boolean;
  status?: 'accepted' | 'dispatching' | 'success' | 'error';
  agentId?: string;
  agentTitle?: string;
  txHash?: string;
  jobId?: string;
  result?: string;
  error?: string;
  meta?: {
    verified: boolean;
    amountPaid?: string;
    blockNumber?: string;
    rate?: string;
  };
}

// ── Settle helper with retry and backoff ───────────────────────────────────────
async function settlePaymentWithRetry(payload: any, requirements: any): Promise<any> {
  if (MOCK_AUTH_ENABLED) {
    const sig = payload.payload?.signature;
    const jobId = payload.payload?.authorization?.nonce ?? 'mock_job';
    if (sig === 'mock_fail_always') {
      throw new Error('Circle Gateway settle failed (500): Mocked permanent failure');
    }
    if (sig === 'mock_fail_once') {
      const failKey = `${jobId}_fail_once`;
      if (!mockFailures.has(failKey)) {
        mockFailures.add(failKey);
        throw new Error('Circle Gateway settle failed (500): Mocked one-time failure');
      }
    }
    return { success: true, transaction: '0xmock_settle_tx_' + Math.random().toString(36).substring(2) };
  }

  const innerPayload = payload.payload ? payload.payload : {
    signature: payload.signature,
    authorization: payload.authorization
  };

  const enrichedPayload = {
    x402Version: payload.x402Version ?? 2,
    resource: {
      url: `http://localhost:${PORT}/dispatch`,
      description: 'Agent Task Dispatch Execution',
      mimeType: 'application/json',
    },
    accepted: requirements,
    payload: innerPayload,
  };

  let attempt = 0;
  let delay = 1000;
  while (attempt < 3) {
    try {
      console.log('[dispatcher] Initiating Circle Facilitator Settle...');
      console.log('[dispatcher] Enriched Payment Payload:', JSON.stringify(enrichedPayload, null, 2));
      console.log('[dispatcher] Payment Requirements:', JSON.stringify(requirements, null, 2));

      const res = await facilitator.settle(enrichedPayload, requirements);
      console.log('[dispatcher] Circle Settle Response:', JSON.stringify(res, null, 2));

      if (res.success) {
        try {
          recordTransaction({
            userAddress: requirements.payTo || ENGINE_WALLET_ADDRESS,
            agentId: 'agent_nanopayment',
            agentName: 'Nanopayment Micro-Fee',
            txType: 'Nanopayment',
            amountUsdc: Number(requirements.amount) / 1e6,
            status: 'SUCCESS',
            txHash: res.transaction || `0x${Math.random().toString(16).slice(2)}`,
            timestamp: new Date().toISOString(),
          });
        } catch { /* ignore */ }
        return res;
      }
      // If server returned success: false with an explicit error, don't retry (invalid signature etc)
      const errorMsg = res.errorReason || res.message || res.error || JSON.stringify(res);
      throw new Error(`Facilitator settle returned success=false: ${errorMsg}`);
    } catch (err: any) {
      attempt++;
      console.error(`[settle-retry] Settle attempt ${attempt} failed. Error:`, err.message, err.stack);
      if (attempt >= 3) {
        throw err;
      }
      console.warn(`[settle-retry] Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

// ── Core Dispatcher ───────────────────────────────────────────────────────────

async function dispatch(
  req: DispatchRequest,
  _headers: http.IncomingHttpHeaders
): Promise<{ statusCode: number; payload: any }> {
  const { intent, agentType, buyerAddress, paymentPayload } = req;

  if (!intent || !agentType) {
    return {
      statusCode: 400,
      payload: { success: false, error: 'Missing required fields: intent, agentType' }
    };
  }

  let verifiedAddress: string;
  let verifiedUserId: string;
  try {
    const authResult = await verifyRequestAuth(_headers as Record<string, string | string[] | undefined>);
    verifiedAddress = authResult.walletAddress;
    verifiedUserId  = authResult.userId;
  } catch (authErr: any) {
    const msg = authErr instanceof Error ? authErr.message : String(authErr);
    console.warn(`[dispatcher] Auth rejection: ${msg}`);
    return {
      statusCode: 401,
      payload: { success: false, error: `Unauthorized: ${msg}` }
    };
  }

  const claimedAddress = (buyerAddress ?? (_headers['x-unverified-client-address'] as string | undefined) ?? '').toLowerCase();
  if (claimedAddress && claimedAddress !== verifiedAddress) {
    console.warn(`[dispatcher] Address mismatch: token=${verifiedAddress} claimed=${claimedAddress}`);
    return {
      statusCode: 403,
      payload: { success: false, error: 'Forbidden: claimed address does not match authenticated identity.' }
    };
  }

  // Failure Isolation Test Trigger (test/dev mode only)
  if (MOCK_AUTH_ENABLED && intent === 'force_failure') {
    console.log('[dispatcher] [TEST] force_failure triggered — throwing.');
    throw new Error('Simulated dispatch failure');
  }

  // Request Serialization per user address
  const currentQueue = userDispatchQueues.get(verifiedAddress) || Promise.resolve();

  let resolveDispatch: (val: { statusCode: number; payload: any }) => void;
  let rejectDispatch: (err: any) => void;
  const dispatchPromise = new Promise<{ statusCode: number; payload: any }>((resolve, reject) => {
    resolveDispatch = resolve;
    rejectDispatch = reject;
  });

  const nextQueue = currentQueue.then(async () => {
    try {
      const res = await executeDispatchInner(req, _headers, verifiedAddress, verifiedUserId);
      resolveDispatch(res);
    } catch (err) {
      rejectDispatch(err);
    }
  }).catch(() => {});

  userDispatchQueues.set(verifiedAddress, nextQueue);

  nextQueue.finally(() => {
    if (userDispatchQueues.get(verifiedAddress) === nextQueue) {
      userDispatchQueues.delete(verifiedAddress);
    }
  });

  return dispatchPromise;
}

async function executeDispatchInner(
  req: DispatchRequest,
  _headers: http.IncomingHttpHeaders,
  verifiedAddress: string,
  verifiedUserId: string
): Promise<{ statusCode: number; payload: any }> {
  const { intent, agentType, paymentPayload } = req;
  const userId: string | undefined = req.userId || (_headers['x-user-id'] as string | undefined);
  const resolvedUserId = verifiedUserId || userId || verifiedAddress;

  const agentEntry = await getAgentRegistryEntry(agentType);
  // agentEntry is never null now (returns a stub for preset agents).
  // The local agentRegistry config is still required — it defines the handler.
  const config = agentRegistry[agentEntry.agentId];
  if (!config) {
    return {
      statusCode: 400,
      payload: { success: false, error: `Agent "${agentEntry.agentId}" has no local workspace handler registered in this engine.` }
    };
  }

  // License check
  try {
    let licensed = false;
    if (MOCK_AUTH_ENABLED) {
      licensed = true;
    } else {
      licensed = await verifyUserLicense(verifiedAddress as Address, agentEntry.agentId);
    }
    if (!licensed) {
      console.warn(`[dispatcher] License denied: ${verifiedAddress} → ${agentEntry.agentId}`);
      return {
        statusCode: 402,
        payload: {
          success: false,
          error: `No active license for agent "${agentEntry.title}". Purchase a license in the Marketplace first.`,
        }
      };
    }
  } catch (licenseErr: any) {
    const msg = licenseErr instanceof Error ? licenseErr.message : String(licenseErr);
    console.error(`[dispatcher] License check RPC error: ${msg}`);
    return {
      statusCode: 503,
      payload: { success: false, error: 'License verification temporarily unavailable. Try again in a moment.' }
    };
  }

  // Check user availableBalance in GatewayWallet
  let balance: bigint;
  try {
    balance = await checkUserBalance(verifiedAddress);
  } catch (err: any) {
    return {
      statusCode: 503,
      payload: { success: false, error: `Gateway wallet balance query failed: ${err.message}` }
    };
  }

  if (balance < 100n) {
    return {
      statusCode: 402,
      payload: {
        success: false,
        error: `Insufficient Gateway balance. Minimum 100 atomic units ($0.0001 USDC) required. Available: ${balance.toString()} atomic units.`
      }
    };
  }

  // ── Spend-Limit Policy Gate (Hard-stop) ──
  // Calculate tentative task cost to check policy limits before execution
  const inputTokensForPolicy = estimateTokenCount(intent);
  const tentativeCostAtomic = config.rateConfig.heavyTask
    ? (BigInt(inputTokensForPolicy) * config.rateConfig.inputTokenRateAtomic / 1000n + 2000n * config.rateConfig.outputTokenRateAtomic / 1000n + 4n * config.rateConfig.milestoneRateAtomic)
    : (config.rateConfig.minFeeAtomic ?? 300n);

  const policyCheck = checkSpendPolicy({
    userAddress: verifiedAddress,
    amountAtomic: tentativeCostAtomic,
    targetAddress: agentEntry.agentId,
  });

  if (!policyCheck.allowed) {
    console.warn(`[spend-policy] HARD-STOP: Execution blocked for ${verifiedAddress}: ${policyCheck.reason}`);
    return {
      statusCode: 429,
      payload: {
        success: false,
        error: `Spending Policy Hard-Stop: ${policyCheck.reason}`,
        policyBlocked: true,
      }
    };
  }

  // ── Light Agent Flow (heavyTask === false) ──
  if (!config.rateConfig.heavyTask) {
    // Check pending unpaid jobs cap (max 3)
    let pendingCount = 0;
    const now = Date.now();
    for (const job of pendingJobs.values()) {
      if (job.buyerAddress === verifiedAddress && job.expiresAt > now) {
        pendingCount++;
      }
    }
    if (pendingCount >= 3) {
      return {
        statusCode: 429,
        payload: {
          success: false,
          error: 'Too many pending unpaid jobs. Please settle or wait for existing jobs to expire.'
        }
      };
    }

    try {
      const jobId = ethers.keccak256(
        ethers.toUtf8Bytes(`${verifiedAddress}-${agentType}-${Date.now()}`)
      ) as string;

      const workerStart = Date.now();
      const agentContext = { verifiedUserAddress: verifiedAddress, userId: resolvedUserId };
      const output = await config.handler(intent, agentContext);

      // Compute resource billing
      const inputTokens = estimateTokenCount(intent);
      const outputTokens = estimateTokenCount(output.analysis);
      const milestonesCompleted = 1;
      const feeResult = computeResourceFee({
        inputTokens,
        outputTokens,
        milestonesCompleted,
        inputTokenRateAtomic: config.rateConfig.inputTokenRateAtomic,
        outputTokenRateAtomic: config.rateConfig.outputTokenRateAtomic,
        milestoneRateAtomic: config.rateConfig.milestoneRateAtomic,
      });

      const actualCostAtomic = feeResult.feeAtomic;

      // Compile Markdown result
      const formattedMetrics = JSON.stringify(output.liveMetrics, null, 2);
      const compiledMarkdown = `---
### 🔎 Data Lineage & Verification
• Data Source: ${output.dataSource}
• Target Identity: [${output.targetIdentity}](${output.verifiedSourceUrl})
• Live Metrics:
\`\`\`json
${formattedMetrics}
\`\`\`

---

${output.analysis}

<details>
<summary>⚙️ View System Logs & Transaction Details</summary>

\`\`\`logs
[Runtime Duration: ${Date.now() - workerStart}ms]
[On-chain Settlement Fee: ${feeResult.feeDisplay} USDC]
\`\`\`
</details>`;

      // Store job
      const expiresAt = Date.now() + 5 * 60 * 1000; // 5 min TTL
      const pendingJob: PendingJob = {
        jobId,
        buyerAddress: verifiedAddress,
        userId: resolvedUserId,  // Persist verified auth identity so settle path can use it
        agentId: agentEntry.agentId,
        actualCostAtomic: actualCostAtomic.toString(),
        result: compiledMarkdown,
        logs: [`[system] Initiating task routing for agent: ${agentEntry.title}`, `[system] Completed successfully.`],
        timestamp: Date.now(),
        expiresAt,
      };
      pendingJobs.set(jobId, pendingJob);
      savePendingJobs(pendingJobs);

      return {
        statusCode: 402,
        payload: {
          jobId,
          actualCostAtomic: Number(actualCostAtomic),
          paymentRequired: true
        }
      };

    } catch (err: any) {
      console.error(`[dispatcher] Light agent dispatch error: ${err.message}`);
      return {
        statusCode: 500,
        payload: { success: false, error: `Dispatch failed: ${err.message}` }
      };
    }
  }

  // ── Heavy Agent Flow (heavyTask === true) ──
  const inputTokens = estimateTokenCount(intent);
  const outputCeiling = 2000;
  const maxMilestones = 4;
  const inputTokenCost = (BigInt(inputTokens) * config.rateConfig.inputTokenRateAtomic) / 1000n;
  const outputTokenCost = (BigInt(outputCeiling) * config.rateConfig.outputTokenRateAtomic) / 1000n;
  const milestoneCost = BigInt(maxMilestones) * config.rateConfig.milestoneRateAtomic;
  const estimatedCost = inputTokenCost + outputTokenCost + milestoneCost;

  if (req.maxTaskBudget !== undefined) {
    const budgetLimit = ethers.parseUnits(req.maxTaskBudget.toString(), 6);
    if (estimatedCost > budgetLimit) {
      return {
        statusCode: 400,
        payload: {
          success: false,
          error: `Estimated cost ${ethers.formatUnits(estimatedCost.toString(), 6)} USDC exceeds maximum budget ${req.maxTaskBudget} USDC.`
        }
      };
    }
  }

  if (!paymentPayload) {
    return {
      statusCode: 402,
      payload: {
        success: false,
        error: "Payment payload signature required for heavy agent task.",
        paymentRequired: true,
        estimatedCostAtomic: estimatedCost.toString()
      }
    };
  }

  try {
    const requirements = {
      scheme: 'exact',
      network: 'eip155:5042002',
      asset: USDC_ADDRESS_ARC,
      amount: estimatedCost.toString(),
      payTo: ENGINE_WALLET_ADDRESS,
      maxTimeoutSeconds: 604900,
      extra: {
        name: 'GatewayWalletBatched',
        version: '1',
        verifyingContract: GATEWAY_WALLET_ADDRESS,
      },
    };

    console.log(`[dispatcher] Settle lock payment for Heavy Agent: ${ethers.formatUnits(estimatedCost.toString(), 6)} USDC`);
    const settleRes = await settlePaymentWithRetry(paymentPayload, requirements);
    const executionId = settleRes.transaction; // Settle tx hash acts as jobId

    if (MOCK_AUTH_ENABLED) {
      // Deduct from mock balance
      const cur = mockBalances.get(verifiedAddress.toLowerCase()) ?? 5000n;
      mockBalances.set(verifiedAddress.toLowerCase(), cur - estimatedCost);
    }

    const workerStartMs = Date.now();
    const initialLogs = [
      `[system] Initiating task routing for agent: ${agentEntry.title}`,
      `[system] Lock payment settled: ${ethers.formatUnits(estimatedCost.toString(), 6)} USDC (tx ${executionId})`,
      `[system] Job ID: ${executionId}`,
      `[system] Spawning decoupled execution worker...`,
    ];

    activeExecutions.set(executionId, {
      txHash: executionId,
      agentId: agentEntry.agentId,
      agentTitle: agentEntry.title,
      intent,
      status: 'Running',
      logs: initialLogs,
      lockedAtomicUnits: estimatedCost,
      startedAt: workerStartMs,
    });

    // Run heavy task background execution
    triggerBackgroundExecutionHeavy(
      executionId,
      agentEntry.agentId,
      agentEntry.title,
      intent,
      verifiedAddress,
      resolvedUserId,
      estimatedCost
    );

    return {
      statusCode: 202,
      payload: {
        success: true,
        status: 'accepted',
        agentId: agentEntry.agentId,
        agentTitle: agentEntry.title,
        txHash: executionId,
        jobId: executionId,
        meta: {
          verified: true,
          amountPaid: ethers.formatUnits(estimatedCost.toString(), 6),
          rate: `${ethers.formatUnits(estimatedCost.toString(), 6)} USDC estimated lock settled`,
        }
      }
    };

  } catch (err: any) {
    console.error(`[dispatcher] Heavy agent dispatch error: ${err.message}`);
    return {
      statusCode: 500,
      payload: { success: false, error: `Settle lock payment failed: ${err.message}` }
    };
  }
}

// Decoupled Background Execution for Heavy Agents
function triggerBackgroundExecutionHeavy(
  jobId: string,
  agentId: string,
  agentTitle: string,
  intent: string,
  buyerAddress: string,
  resolvedUserId: string,
  estimatedCost: bigint
): void {
  (async () => {
    const workerStart = Date.now();
    const config = agentRegistry[agentId];
    if (!config) return;

    const logToExecution = (text: string) => {
      const exec = activeExecutions.get(jobId);
      if (exec) {
        exec.logs.push(text);
        activeExecutions.set(jobId, exec);
      }
    };

    try {
      for (const state of config.loadingStates) {
        await new Promise(r => setTimeout(r, 1200));
        logToExecution(state);
      }

      logToExecution(`[${agentTitle}] Dispatching neural strategy and verifying pool signatures...`);
      const agentContext = { verifiedUserAddress: buyerAddress, userId: resolvedUserId };
      const output = await config.handler(intent, agentContext);

      // Compute actual cost
      const inputTokens = estimateTokenCount(intent);
      const outputTokens = estimateTokenCount(output.analysis);
      const milestonesCompleted = 4; // dex bot uses 4 milestones
      const feeResult = computeResourceFee({
        inputTokens,
        outputTokens,
        milestonesCompleted,
        inputTokenRateAtomic: config.rateConfig.inputTokenRateAtomic,
        outputTokenRateAtomic: config.rateConfig.outputTokenRateAtomic,
        milestoneRateAtomic: config.rateConfig.milestoneRateAtomic,
      });

      const actualCostAtomic = feeResult.feeAtomic;

      logToExecution(`[system] Resource billing computed: ${feeResult.feeDisplay} USDC.`);

      let refundTx = 'N/A';
      if (actualCostAtomic < estimatedCost) {
        const refundAtomic = estimatedCost - actualCostAtomic;
        logToExecution(`[system] Actual cost is lower than estimated lock. Issuing refund of ${ethers.formatUnits(refundAtomic.toString(), 6)} USDC...`);

        // Sign EIP-3009 TransferWithAuthorization for refund
        const now = Math.floor(Date.now() / 1000);
        const nonce = `0x${crypto.randomBytes(32).toString('hex')}`;
        const domain = {
          name: 'GatewayWalletBatched',
          version: '1',
          chainId: 5042002,
          verifyingContract: GATEWAY_WALLET_ADDRESS,
        };
        const types = {
          TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        };
        const message = {
          from: ENGINE_WALLET_ADDRESS,
          to: buyerAddress,
          value: refundAtomic.toString(),
          validAfter: now - 600,
          validBefore: now + 604900,
          nonce,
        };

        const signature = await ethersWallet.signTypedData(domain, types, message);

        const refundPayload = {
          x402Version: 2,
          payload: {
            signature,
            authorization: {
              from: ENGINE_WALLET_ADDRESS,
              to: buyerAddress,
              value: refundAtomic.toString(),
              validAfter: (now - 600).toString(),
              validBefore: (now + 604900).toString(),
              nonce,
            },
          },
        };

        const refundRequirements = {
          scheme: 'exact',
          network: 'eip155:5042002',
          asset: USDC_ADDRESS_ARC,
          amount: refundAtomic.toString(),
          payTo: buyerAddress,
          maxTimeoutSeconds: 604900,
          extra: {
            name: 'GatewayWalletBatched',
            version: '1',
            verifyingContract: GATEWAY_WALLET_ADDRESS,
          },
        };

        const refundRes = await settlePaymentWithRetry(refundPayload, refundRequirements);
        refundTx = refundRes.transaction;
        logToExecution(`[system] Refund settled successfully in tx: ${refundTx}`);

        if (MOCK_AUTH_ENABLED) {
          const cur = mockBalances.get(buyerAddress.toLowerCase()) ?? 5000n;
          mockBalances.set(buyerAddress.toLowerCase(), cur + refundAtomic);
        }
      } else if (actualCostAtomic > estimatedCost) {
        console.log(`[dispatcher] Shortfall of ${ethers.formatUnits((actualCostAtomic - estimatedCost).toString(), 6)} USDC on job ${jobId}. Capped at lock.`);
        logToExecution(`[system] Note: actual cost exceeded estimated budget lock. Shortfall covered by engine.`);
      }

      const formattedMetrics = JSON.stringify(output.liveMetrics, null, 2);
      const compiledMarkdown = `---
### 🔎 Data Lineage & Verification
• Data Source: ${output.dataSource}
• Target Identity: [${output.targetIdentity}](${output.verifiedSourceUrl})
• Live Metrics:
\`\`\`json
${formattedMetrics}
\`\`\`

---

${output.analysis}

<details>
<summary>⚙️ View System Logs & Transaction Details</summary>

\`\`\`logs
[Runtime Duration: ${Date.now() - workerStart}ms]
[On-chain Lock: ${ethers.formatUnits(estimatedCost.toString(), 6)} USDC]
[On-chain Settlement Fee: ${feeResult.feeDisplay} USDC]
[Refund Tx: ${refundTx}]
\`\`\`
</details>`;

      logToExecution(`[system] Completed successfully.`);
      const finalExec = activeExecutions.get(jobId);
      if (finalExec) {
        finalExec.status = 'Success';
        finalExec.result = compiledMarkdown;
        finalExec.actualAtomicUnits = actualCostAtomic;
        activeExecutions.set(jobId, finalExec);
      }

      // Use resolvedUserId (Privy DID or Circle wallet addr) — NOT buyerAddress alone,
      // which would split Privy users' threads across two keys.
      saveChatMessage(resolvedUserId, buyerAddress, agentId, 'agent', compiledMarkdown);
      recordSpend({ userAddress: buyerAddress, amountAtomic: actualCostAtomic, targetAddress: agentId });
      console.log(`[dispatcher] Heavy worker SUCCESS for job ${jobId}`);

    } catch (err: any) {
      const errorMsg = err.message || String(err);
      console.error(`[dispatcher] Heavy worker FAILED for job ${jobId}: ${errorMsg}`);
      const failExec = activeExecutions.get(jobId);
      if (failExec) {
        failExec.status = 'Failed';
        failExec.error = errorMsg;
        failExec.logs.push(`[system] Fatal error: ${errorMsg}`);
        activeExecutions.set(jobId, failExec);
      }

      // Refund full amount on total failure
      try {
        logToExecution(`[system] Job failed. Issuing full refund of ${ethers.formatUnits(estimatedCost.toString(), 6)} USDC...`);
        const now = Math.floor(Date.now() / 1000);
        const nonce = `0x${crypto.randomBytes(32).toString('hex')}`;
        const domain = {
          name: 'GatewayWalletBatched',
          version: '1',
          chainId: 5042002,
          verifyingContract: GATEWAY_WALLET_ADDRESS,
        };
        const types = {
          TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        };
        const message = {
          from: ENGINE_WALLET_ADDRESS,
          to: buyerAddress,
          value: estimatedCost.toString(),
          validAfter: now - 600,
          validBefore: now + 604900,
          nonce,
        };

        const signature = await ethersWallet.signTypedData(domain, types, message);

        const refundPayload = {
          x402Version: 2,
          payload: {
            signature,
            authorization: {
              from: ENGINE_WALLET_ADDRESS,
              to: buyerAddress,
              value: estimatedCost.toString(),
              validAfter: (now - 600).toString(),
              validBefore: (now + 604900).toString(),
              nonce,
            },
          },
        };

        const refundRequirements = {
          scheme: 'exact',
          network: 'eip155:5042002',
          asset: USDC_ADDRESS_ARC,
          amount: estimatedCost.toString(),
          payTo: buyerAddress,
          maxTimeoutSeconds: 604900,
          extra: {
            name: 'GatewayWalletBatched',
            version: '1',
            verifyingContract: GATEWAY_WALLET_ADDRESS,
          },
        };

        const refundRes = await settlePaymentWithRetry(refundPayload, refundRequirements);
        logToExecution(`[system] Full refund settled in tx: ${refundRes.transaction}`);

        if (MOCK_AUTH_ENABLED) {
          const cur = mockBalances.get(buyerAddress.toLowerCase()) ?? 5000n;
          mockBalances.set(buyerAddress.toLowerCase(), cur + estimatedCost);
        }
      } catch (refundErr: any) {
        console.error(`[dispatcher] Full refund failed for job ${jobId}: ${refundErr.message}`);
        logToExecution(`[system] Warning: Full refund failed — ${refundErr.message}`);
      }
    }
  })();
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Payment-Signature, payment-signature, x-unverified-client-address, x-client-claimed-address, x-user-id');
  res.setHeader('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, payment-required');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url ?? '', `http://localhost:${PORT}`);

  // Health check
  if (req.method === 'GET' && parsedUrl.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', service: 'aethel-engine', version: '1.0.0' }));
    return;
  }

  // Get active execution logs/status
  if (req.method === 'GET' && parsedUrl.pathname === '/status') {
    const txHash = parsedUrl.searchParams.get('txHash');
    if (!txHash || txHash === 'all') {
      const allJobs = Array.from(activeExecutions.entries()).map(([k, v]) => ({
        txHash: k,
        agentId: v.agentId,
        status: v.status,
        logs: v.logs,
        error: v.error
      }));
      res.writeHead(200);
      res.end(JSON.stringify({ jobs: allJobs }));
      return;
    }

    const execution = activeExecutions.get(txHash);
    if (!execution) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: `No active execution found for tx ${txHash}` }));
      return;
    }

    res.writeHead(200);
    res.end(JSON.stringify({
      status: execution.status,
      logs: execution.logs,
      result: execution.result,
      error: execution.error
    }));
    return;
  }

  // ── POST /agents/transactions — Record transaction dynamically ────────────
  if (req.method === 'POST' && parsedUrl.pathname === '/agents/transactions') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const rec = recordTransaction(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, transaction: rec }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── GET /agents/transactions — Returns full unified transaction ledger ──────
  if (req.method === 'GET' && parsedUrl.pathname === '/agents/transactions') {
    const userAddress = parsedUrl.searchParams.get('userAddress');
    const records = getUserTransactions(userAddress || '');

    // Query on-chain AgentPurchased events from Arc Testnet
    let onChainLogs: any[] = [];
    try {
      const marketplaceAddr = (process.env.MARKETPLACE_ADDRESS || '0xD3362dB9Afa0D9e0FA6Eb9909527BFb6693AAe53') as Address;
      const deployBlock = BigInt(process.env.MARKETPLACE_DEPLOY_BLOCK || '0');
      const eventAbi = parseAbi([
        'event AgentPurchased(address indexed buyer, string indexed agentId, uint256 totalPaid)'
      ]);

      const logs = await publicClient.getLogs({
        address: marketplaceAddr,
        event: eventAbi[0] as any,
        fromBlock: deployBlock,
        toBlock: 'latest',
      });

      onChainLogs = logs
        .filter(l => (l as any).args?.buyer?.toLowerCase() === (userAddress || '').toLowerCase())
        .map(l => {
          const buyer = (l as any).args?.buyer;
          const agentId = (l as any).args?.agentId;
          const totalPaid = (l as any).args?.totalPaid;
          const amountUsdc = totalPaid ? Number(totalPaid) / 1e6 : 0;

          return {
            id: `onchain_${l.transactionHash}_${l.logIndex}`,
            userAddress: buyer,
            agentId: agentId,
            agentName: agentId ? agentId.replace(/\s+/g, '_') : 'Agent Purchase',
            txType: 'Deployment',
            amountUsdc: amountUsdc,
            status: 'SUCCESS',
            txHash: l.transactionHash,
            timestamp: new Date().toISOString(),
            createdAtMs: Date.now(),
          };
        });
    } catch (err: any) {
      console.warn('[dispatcher] On-chain AgentPurchased log query notice:', err.message);
    }

    // Merge and deduplicate by txHash or id
    const knownHashes = new Set(records.map(r => r.txHash).filter(Boolean));
    const uniqueOnChain = onChainLogs.filter(l => !knownHashes.has(l.txHash));
    const combined = [...records, ...uniqueOnChain].sort((a, b) => b.createdAtMs - a.createdAtMs);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ transactions: combined }));
    return;
  }

  // ── GET /agents/ratings — Returns average rating & review stats ──────────────
  if (req.method === 'GET' && parsedUrl.pathname === '/agents/ratings') {
    const agentId = parsedUrl.searchParams.get('agentId');
    if (agentId) {
      const stats = getAgentRatingStats(agentId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
      return;
    }

    const all = getAllRatings();
    const map: Record<string, { average: number; count: number }> = {};
    for (const r of all) {
      if (!map[r.agentId]) {
        map[r.agentId] = getAgentRatingStats(r.agentId);
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ratings: map }));
    return;
  }

  // ── POST /agents/rate — Submit a rating (gated strictly by on-chain license) ──
  if (req.method === 'POST' && parsedUrl.pathname === '/agents/rate') {
    // 1. Verify caller Authorization token FIRST before touching request body
    let verifiedAddress: string;
    let verifiedUserId: string;
    try {
      const authResult = await verifyRequestAuth(req.headers as Record<string, string | string[] | undefined>);
      verifiedAddress = authResult.walletAddress;
      verifiedUserId  = authResult.userId;
    } catch (authErr: any) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: `Unauthorized: ${authErr.message}` }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        let parsedBody: any = {};
        try {
          parsedBody = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON request body' }));
          return;
        }

        const { agentId, userAddress: bodyUserAddress, rating, comment } = parsedBody as {
          agentId: string;
          userAddress?: string;
          rating: number;
          comment?: string;
        };

        if (!agentId || typeof rating !== 'number') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Missing required fields: agentId, rating' }));
          return;
        }

        if (rating < 1 || rating > 5) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Rating must be an integer between 1 and 5' }));
          return;
        }

        // 2. Derive acting identity strictly from verified token (NOT client-supplied body)
        const userRefId = verifiedUserId || verifiedAddress;
        let feeWalletAddress = verifiedAddress;
        try {
          const fw = await getOrAssignFeeWallet(userRefId);
          if (fw?.address) feeWalletAddress = fw.address;
        } catch { /* fallback to verifiedAddress */ }

        // If client supplied userAddress in body, reject if it conflicts with verified identity
        if (bodyUserAddress && typeof bodyUserAddress === 'string') {
          const supplied = bodyUserAddress.toLowerCase();
          const isMatch = supplied === verifiedAddress.toLowerCase() || supplied === feeWalletAddress.toLowerCase();
          if (!isMatch) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Client-supplied userAddress conflicts with verified identity.' }));
            return;
          }
        }

        // 3. License verification wrapped in try/catch returning clean generic error text on RPC failure
        let hasLicense = false;
        try {
          hasLicense = await verifyUserLicense(verifiedAddress as Address, agentId);
          if (!hasLicense && feeWalletAddress) {
            hasLicense = await verifyUserLicense(feeWalletAddress as Address, agentId);
          }
        } catch (rpcErr: any) {
          console.warn('[dispatcher] On-chain license verification failed during rating:', rpcErr.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Failed to verify on-chain license status. Please try again later.' }));
          return;
        }

        if (!hasLicense) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: `Access denied. Wallet ${verifiedAddress} does not hold an active license for agent ${agentId}.`
          }));
          return;
        }

        const actingUserAddress = feeWalletAddress || verifiedAddress;
        const saved = saveRating({ agentId, userAddress: actingUserAddress, rating: Math.round(rating), comment });
        const stats = getAgentRatingStats(agentId);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Rating submitted successfully',
          rating: saved,
          stats
        }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message || 'Internal server error' }));
      }
    });
    return;
  }


  // ── Agent Purchase endpoint ───────────────────────────────────────────────
  // POST /agents/purchase — executes USDC.approve + purchaseAgent on-chain
  // from the user's Fee Wallet (Developer-Controlled EOA), server-side.
  // No browser challenge / executeChallenge required.
  // Auth: Circle W3S Bearer token in Authorization header.
  if (req.method === 'POST' && parsedUrl.pathname === '/agents/purchase') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { agentId } = JSON.parse(body) as { agentId: string };

        if (!agentId) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'Missing required field: agentId' }));
          return;
        }

        // 1. Verify caller identity
        let verifiedAddress: string;
        let verifiedUserId: string;
        try {
          const authResult = await verifyRequestAuth(req.headers as Record<string, string | string[] | undefined>);
          verifiedAddress = authResult.walletAddress;
          verifiedUserId  = authResult.userId;
        } catch (authErr: any) {
          res.writeHead(401);
          res.end(JSON.stringify({ success: false, error: `Unauthorized: ${authErr.message}` }));
          return;
        }

        // 2. Resolve agent price from registry (preset agents return price=0n stub)
        const agentEntry = await getAgentRegistryEntry(agentId);
        // agentEntry is never null — getAgentRegistryEntry returns a stub for preset/legacy agents.
        // Price will be fetched from the on-chain ABI for listed agents, or 0n for presets.

        // 3. Resolve Fee Wallet (provisions if not yet created)
        const userRefId = verifiedUserId || verifiedAddress;
        let feeWallet: { address: string; id: string };
        try {
          feeWallet = await getOrAssignFeeWallet(userRefId);
        } catch (feeErr: any) {
          res.writeHead(503);
          res.end(JSON.stringify({ success: false, error: `Fee Wallet provisioning failed: ${feeErr.message}` }));
          return;
        }

        // 4. Check if already licensed under Fee Wallet (idempotent guard)
        // Also handles preset agents (license granted via grantLicense, price=0) —
        // they will always return alreadyLicensed=true and we short-circuit here.
        let alreadyLicensed = false;
        try {
          alreadyLicensed = await verifyUserLicense(feeWallet.address as Address, agentId);
        } catch (licErr: any) {
          res.writeHead(502);
          res.end(JSON.stringify({ success: false, error: `License check failed: ${licErr.message}` }));
          return;
        }

        if (alreadyLicensed) {
          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            alreadyOwned: true,
            feeWalletAddress: feeWallet.address,
            message: `Fee Wallet already holds a license for "${agentId}".`,
          }));
          return;
        }

        // 5. Build ABI-encoded calldata for on-chain purchase (USDC.approve + purchaseAgent)
        const PURCHASE_ABI = parseAbi([
          'function approve(address spender, uint256 amount) external returns (bool)',
          'function purchaseAgent(string calldata agentId) external',
        ]);

        const MARKETPLACE_ADDRESS = process.env.MARKETPLACE_ADDRESS as Address;
        const USDC_ADDRESS_ENV    = process.env.USDC_ADDRESS as Address;

        if (!MARKETPLACE_ADDRESS || !USDC_ADDRESS_ENV) {
          res.writeHead(503);
          res.end(JSON.stringify({ success: false, error: 'MARKETPLACE_ADDRESS or USDC_ADDRESS not configured in ENGINE .env' }));
          return;
        }

        const { encodeFunctionData } = await import('viem');

        const approveCalldata  = encodeFunctionData({ abi: PURCHASE_ABI, functionName: 'approve',       args: [MARKETPLACE_ADDRESS, agentEntry.price] });
        const purchaseCalldata = encodeFunctionData({ abi: PURCHASE_ABI, functionName: 'purchaseAgent', args: [agentId] });




        const circleClient = getCircleClient();
        const idempBase    = `fee-purchase-${feeWallet.id}-${agentId}`;

        // ── Helper: submit a Developer-Controlled contract execution tx and poll for hash ──
        async function execAndPoll(calldata: string, contractAddress: string, label: string): Promise<string> {
          try {
            const { randomUUID } = await import('crypto');
            const txRes = await (circleClient as any).createContractExecutionTransaction({
              idempotencyKey: randomUUID(),
              walletId:        feeWallet.id,
              contractAddress,
              callData:        calldata,
              fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
            });

            const txId = txRes?.data?.id || txRes?.data?.transaction?.id;
            if (txId) {
              console.log(`[purchase] ${label} tx submitted via Circle API — id=${txId}, polling...`);
              const TERMINAL = new Set(['COMPLETE', 'FAILED', 'CANCELLED', 'DENIED']);
              for (let i = 0; i < 60; i++) {
                await new Promise(r => setTimeout(r, 2000));
                const pollRes = await (circleClient as any).getTransaction({ id: txId });
                const tx = pollRes?.data?.transaction ?? pollRes?.data;
                if (!tx) continue;
                const state = (tx.state || tx.status || '').toUpperCase();
                if (tx.txHash) {
                  try { await publicClient.waitForTransactionReceipt({ hash: tx.txHash as `0x${string}` }); } catch {}
                  return tx.txHash as string;
                }
                if (TERMINAL.has(state) && !tx.txHash) {
                  throw new Error(`${label} transaction ${state.toLowerCase()}: ${tx.errorReason || tx.errorMessage || 'no reason given'}`);
                }
              }
            }
          } catch (circleErr: any) {
            console.warn(`[purchase] Circle API execution for ${label} warning: ${circleErr?.response?.data?.message || circleErr?.message || circleErr}. Falling back to EVM signer...`);
          }

          // EVM direct transaction fallback using feeWallet's private key
          let signer = ethersWallet;
          if ((feeWallet as any).privateKey) {
            signer = new ethers.Wallet((feeWallet as any).privateKey, ethersProvider);
          }

          console.log(`[purchase] Executing ${label} via EVM signer ${signer.address}...`);
          const txResponse = await signer.sendTransaction({
            to: contractAddress,
            data: calldata,
          });
          const receipt = await txResponse.wait();
          return receipt?.hash || txResponse.hash;
        }

        // 6. Execute approve from Fee Wallet
        console.log(`[purchase] Step 1/2: USDC.approve(${MARKETPLACE_ADDRESS}, ${agentEntry.price}) from Fee Wallet ${feeWallet.address}`);
        try {
          await execAndPoll(approveCalldata, USDC_ADDRESS_ENV, 'approve');
        } catch (approveErr: any) {
          res.writeHead(502);
          res.end(JSON.stringify({ success: false, error: `USDC approve failed: ${approveErr.message}` }));
          return;
        }

        // 7. Execute purchaseAgent from Fee Wallet
        console.log(`[purchase] Step 2/2: purchaseAgent("${agentId}") from Fee Wallet ${feeWallet.address}`);
        let purchaseTxHash: string;
        try {
          purchaseTxHash = await execAndPoll(purchaseCalldata, MARKETPLACE_ADDRESS, 'purchaseAgent');
        } catch (purchaseErr: any) {
          res.writeHead(502);
          res.end(JSON.stringify({ success: false, error: `purchaseAgent failed: ${purchaseErr.message}` }));
          return;
        }

        console.log(`[purchase] ✓ Agent "${agentId}" purchased by Fee Wallet ${feeWallet.address} — tx: ${purchaseTxHash}`);
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          txHash: purchaseTxHash,
          feeWalletAddress: feeWallet.address,
          agentId,
        }));
      } catch (err: any) {
        console.error('[/agents/purchase] Unexpected error:', err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: err.message || 'Internal server error' }));
      }
    });
    return;
  }

  // ── Gateway Deposit endpoint ──────────────────────────────────────────────
  // POST /agents/gateway-deposit — Fee Wallet does USDC.approve() then Gateway.deposit()
  // server-side via entity-secret. No browser popup, no challenge.
  // Body: { amountUsdc: string }   e.g. "5.00"
  // Auth: Circle W3S Bearer token (used to resolve Fee Wallet).

  if (req.method === 'POST' && parsedUrl.pathname === '/agents/gateway-deposit') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { amountUsdc } = JSON.parse(body) as { amountUsdc: string };
        if (!amountUsdc || isNaN(parseFloat(amountUsdc)) || parseFloat(amountUsdc) <= 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'Missing or invalid amountUsdc' }));
          return;
        }

        // 1. Auth
        let verifiedAddress: string;
        let verifiedUserId: string;
        try {
          const authResult = await verifyRequestAuth(req.headers as Record<string, string | string[] | undefined>);
          verifiedAddress = authResult.walletAddress;
          verifiedUserId  = authResult.userId;
        } catch (authErr: any) {
          res.writeHead(401);
          res.end(JSON.stringify({ success: false, error: `Unauthorized: ${authErr.message}` }));
          return;
        }

        // 2. Resolve Fee Wallet
        const userRefId = verifiedUserId || verifiedAddress;
        let feeWallet: { address: string; id: string };
        try {
          feeWallet = await getOrAssignFeeWallet(userRefId);
        } catch (feeErr: any) {
          res.writeHead(503);
          res.end(JSON.stringify({ success: false, error: `Fee Wallet provisioning failed: ${feeErr.message}` }));
          return;
        }

        const amountAtomic = BigInt(Math.round(parseFloat(amountUsdc) * 1_000_000));
        const USDC_ADDR    = process.env.USDC_ADDRESS as Address;
        const GW_ADDR      = (process.env.GATEWAY_ADDRESS ?? '0x0077777d7EBA4688BDeF3E311b846F25870A19B9') as Address;

        const DEPOSIT_ABI = parseAbi([
          'function approve(address spender, uint256 amount) external returns (bool)',
          'function deposit(address token, uint256 amount) external',
        ]);

        const { encodeFunctionData } = await import('viem');

        const approveCalldata = encodeFunctionData({
          abi: DEPOSIT_ABI,
          functionName: 'approve',
          args: [GW_ADDR, amountAtomic],
        });
        const depositCalldata = encodeFunctionData({
          abi: DEPOSIT_ABI,
          functionName: 'deposit',
          args: [USDC_ADDR, amountAtomic],
        });

        const circleClient = getCircleClient();

        async function execDepositTx(calldata: string, contractAddress: string, label: string): Promise<string> {
          try {
            const { randomUUID } = await import('crypto');
            const txRes = await (circleClient as any).createContractExecutionTransaction({
              idempotencyKey: randomUUID(),
              walletId:       feeWallet.id,
              contractAddress,
              callData:       calldata,
              fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
            });

            const txId = txRes?.data?.id || txRes?.data?.transaction?.id;
            if (txId) {
              console.log(`[gateway-deposit] ${label} tx submitted via Circle API — id=${txId}, polling...`);
              const TERMINAL = new Set(['COMPLETE', 'FAILED', 'CANCELLED', 'DENIED']);
              for (let i = 0; i < 60; i++) {
                await new Promise(r => setTimeout(r, 2000));
                const pollRes = await (circleClient as any).getTransaction({ id: txId });
                const tx = pollRes?.data?.transaction ?? pollRes?.data;
                if (!tx) continue;
                const state = (tx.state || tx.status || '').toUpperCase();
                if (tx.txHash) {
                  try { await publicClient.waitForTransactionReceipt({ hash: tx.txHash as `0x${string}` }); } catch {}
                  return tx.txHash as string;
                }
                if (TERMINAL.has(state) && !tx.txHash) {
                  throw new Error(`${label} transaction ${state.toLowerCase()}: ${tx.errorReason || 'no reason given'}`);
                }
              }
            }
          } catch (circleErr: any) {
            console.warn(`[gateway-deposit] Circle API execution for ${label} warning: ${circleErr?.response?.data?.message || circleErr?.message || circleErr}. Falling back to EVM signer...`);
          }

          // EVM direct transaction fallback
          let signer = ethersWallet;
          if ((feeWallet as any).privateKey) {
            signer = new ethers.Wallet((feeWallet as any).privateKey, ethersProvider);
          }

          console.log(`[gateway-deposit] Executing ${label} via EVM signer ${signer.address}...`);
          const txResponse = await signer.sendTransaction({
            to: contractAddress,
            data: calldata,
          });
          const receipt = await txResponse.wait();
          return receipt?.hash || txResponse.hash;
        }

        // Step 1: USDC.approve(gatewayAddress, amount)
        let approveTxHash: string;
        try {
          console.log(`[gateway-deposit] Approving ${amountUsdc} USDC from Fee Wallet ${feeWallet.address} to Gateway ${GW_ADDR}...`);
          approveTxHash = await execDepositTx(approveCalldata, USDC_ADDR, 'approve');
          console.log(`[gateway-deposit] ✓ Approve tx: ${approveTxHash}`);
        } catch (approveErr: any) {
          res.writeHead(502);
          res.end(JSON.stringify({ success: false, error: `USDC approve failed: ${approveErr.message}` }));
          return;
        }

        // Step 2: Gateway.deposit(usdcAddress, amount)
        let depositTxHash: string;
        try {
          console.log(`[gateway-deposit] Depositing ${amountUsdc} USDC into Gateway ${GW_ADDR}...`);
          depositTxHash = await execDepositTx(depositCalldata, GW_ADDR, 'deposit');
          console.log(`[gateway-deposit] ✓ Deposit tx: ${depositTxHash}`);
        } catch (depositErr: any) {
          res.writeHead(502);
          res.end(JSON.stringify({ success: false, error: `Gateway deposit failed: ${depositErr.message}`, approveTxHash }));
          return;
        }

        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          approveTxHash,
          depositTxHash,
          feeWalletAddress: feeWallet.address,
          amountUsdc,
        }));
      } catch (err: any) {
        console.error('[/agents/gateway-deposit] Unexpected error:', err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: err.message || 'Internal server error' }));
      }
    });
    return;
  }

  // ── Gateway Withdraw endpoint ─────────────────────────────────────────────
  // GET /agents/gateway-withdraw or POST /agents/gateway-withdraw
  if (parsedUrl.pathname === '/agents/gateway-withdraw') {
    if (req.method === 'GET') {
      try {
        const action      = parsedUrl.searchParams.get('action');
        const userAddress = parsedUrl.searchParams.get('userAddress');
        const amountUsdc  = parsedUrl.searchParams.get('amountUsdc');

        if (action !== 'estimate') {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Unknown action' })); return;
        }
        if (!userAddress || !amountUsdc) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Missing userAddress or amountUsdc' })); return;
        }

        const parsed = parseFloat(amountUsdc);
        if (isNaN(parsed) || parsed <= 0) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid amountUsdc' })); return;
        }

        const amountBaseUnits = BigInt(Math.round(parsed * 1_000_000)).toString();

        const spec = cleanTransferSpec({
          version: 1,
          sourceDomain: ARC_DOMAIN,
          destinationDomain: ARC_DOMAIN,
          sourceContract: GATEWAY_WALLET,
          destinationContract: GATEWAY_MINTER,
          sourceToken: USDC_ARC,
          destinationToken: USDC_ARC,
          sourceDepositor: userAddress,
          destinationRecipient: userAddress,
          sourceSigner: userAddress,
          destinationCaller: '0',
          value: amountBaseUnits,
          salt: crypto.randomBytes(32).toString('hex'),
          hookData: '0x',
        }, userAddress);

        const estimateRes = await fetch(`${GATEWAY_FACILITATOR_URL}/v1/estimate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([{ spec }]),
        });

        const estimateData = await estimateRes.json();
        if (!estimateRes.ok) {
          res.writeHead(estimateRes.status);
          res.end(JSON.stringify({ error: estimateData?.message ?? 'Estimate failed', detail: estimateData }));
          return;
        }

        const estimated = estimateData?.[0]?.burnIntent || estimateData.body?.[0]?.burnIntent;
        if (!estimated) {
          res.writeHead(500); res.end(JSON.stringify({ error: 'Estimate returned no burn intent' })); return;
        }

        const cleanedSpec = cleanTransferSpec(estimated.spec ?? spec, userAddress);
        const estMaxFee = BigInt(estimated.maxFee || '0');
        const maxFeeBuffered = estMaxFee > BigInt(25_000) ? estMaxFee : BigInt(25_000);

        res.writeHead(200);
        res.end(JSON.stringify({
          burnIntentSpec: {
            maxBlockHeight: estimated.maxBlockHeight.toString(),
            maxFee: maxFeeBuffered.toString(),
            spec: cleanedSpec,
          },
          eip712Domain: { name: 'GatewayWallet', version: '1' },
          eip712Types: {
            BurnIntent: [
              { name: 'maxBlockHeight', type: 'uint256' },
              { name: 'maxFee', type: 'uint256' },
              { name: 'spec', type: 'TransferSpec' },
            ],
            TransferSpec: [
              { name: 'version', type: 'uint32' },
              { name: 'sourceDomain', type: 'uint32' },
              { name: 'destinationDomain', type: 'uint32' },
              { name: 'sourceContract', type: 'bytes32' },
              { name: 'destinationContract', type: 'bytes32' },
              { name: 'sourceToken', type: 'bytes32' },
              { name: 'destinationToken', type: 'bytes32' },
              { name: 'sourceDepositor', type: 'bytes32' },
              { name: 'destinationRecipient', type: 'bytes32' },
              { name: 'sourceSigner', type: 'bytes32' },
              { name: 'destinationCaller', type: 'bytes32' },
              { name: 'value', type: 'uint256' },
              { name: 'salt', type: 'bytes32' },
              { name: 'hookData', type: 'bytes' },
            ],
          },
          fees: estimateData.fees,
        }));
      } catch (err: any) {
        res.writeHead(500); res.end(JSON.stringify({ error: err.message || 'Internal server error' }));
      }
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const parsedBody = JSON.parse(body || '{}');
          const { userAddress, amountUsdc } = parsedBody;
          let { signature, burnIntentSpec } = parsedBody;

          if (!userAddress || !amountUsdc) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'Missing userAddress or amountUsdc' })); return;
          }

          const parsed = parseFloat(amountUsdc);
          if (isNaN(parsed) || parsed <= 0) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid amountUsdc' })); return;
          }

          if (!signature || !burnIntentSpec) {
            let feeWalletAddress = userAddress;
            let feeWalletId: string | null = null;
            try {
              let fw: { address: string; id: string } | null = null;
              try { fw = await getOrAssignFeeWallet(userAddress); } catch {}

              if (!fw || (fw.address.toLowerCase() !== userAddress.toLowerCase() && (userAddress.toLowerCase().startsWith('0xa2d1') || userAddress.toLowerCase().startsWith('0x320f')))) {
                const client = getCircleClient();
                const walletsRes = await client.listWallets({});
                const match = (walletsRes.data?.wallets || []).find(
                  (w: any) => w.address?.toLowerCase() === userAddress.toLowerCase() || w.refId?.toLowerCase() === userAddress.toLowerCase()
                );
                if (match) fw = { address: match.address, id: match.id };
              }

              if (fw) {
                feeWalletAddress = fw.address;
                feeWalletId = fw.id;
              }
            } catch (fwErr: any) {
              console.warn('[gateway-withdraw] Could not resolve Fee Wallet via Engine, using userAddress:', fwErr.message);
            }

            const amountBaseUnits = BigInt(Math.round(parsed * 1_000_000)).toString();

            const spec = cleanTransferSpec({
              version: 1,
              sourceDomain: ARC_DOMAIN,
              destinationDomain: ARC_DOMAIN,
              sourceContract: GATEWAY_WALLET,
              destinationContract: GATEWAY_MINTER,
              sourceToken: USDC_ARC,
              destinationToken: USDC_ARC,
              sourceDepositor: feeWalletAddress,
              destinationRecipient: userAddress,
              sourceSigner: feeWalletAddress,
              destinationCaller: '0',
              value: amountBaseUnits,
              salt: crypto.randomBytes(32).toString('hex'),
              hookData: '0x',
            }, feeWalletAddress, userAddress);

            const estimateRes = await fetch(`${GATEWAY_FACILITATOR_URL}/v1/estimate`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify([{ spec }]),
            });

            const estimateData = await estimateRes.json();
            if (!estimateRes.ok) {
              res.writeHead(estimateRes.status);
              res.end(JSON.stringify({ error: estimateData?.message ?? 'Estimate failed', detail: estimateData }));
              return;
            }

            const estimated = estimateData?.[0]?.burnIntent || estimateData.body?.[0]?.burnIntent;
            if (!estimated) {
              res.writeHead(500); res.end(JSON.stringify({ error: 'Estimate returned no burn intent' })); return;
            }

            const formattedSpec = cleanTransferSpec(estimated.spec ?? spec, feeWalletAddress, userAddress);
            const estMaxFee = BigInt(estimated.maxFee || '0');
            const maxFeeBuffered = estMaxFee > BigInt(25_000) ? estMaxFee : BigInt(25_000);

            const eip712Data = {
              domain: { name: 'GatewayWallet', version: '1' },
              types: {
                EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }],
                BurnIntent: [{ name: 'maxBlockHeight', type: 'uint256' }, { name: 'maxFee', type: 'uint256' }, { name: 'spec', type: 'TransferSpec' }],
                TransferSpec: [
                  { name: 'version', type: 'uint32' }, { name: 'sourceDomain', type: 'uint32' }, { name: 'destinationDomain', type: 'uint32' },
                  { name: 'sourceContract', type: 'bytes32' }, { name: 'destinationContract', type: 'bytes32' },
                  { name: 'sourceToken', type: 'bytes32' }, { name: 'destinationToken', type: 'bytes32' },
                  { name: 'sourceDepositor', type: 'bytes32' }, { name: 'destinationRecipient', type: 'bytes32' },
                  { name: 'sourceSigner', type: 'bytes32' }, { name: 'destinationCaller', type: 'bytes32' },
                  { name: 'value', type: 'uint256' }, { name: 'salt', type: 'bytes32' }, { name: 'hookData', type: 'bytes' },
                ],
              },
              primaryType: 'BurnIntent',
              message: {
                maxBlockHeight: estimated.maxBlockHeight.toString(),
                maxFee: maxFeeBuffered.toString(),
                spec: formattedSpec,
              },
            };

            if (feeWalletId) {
              const client = getCircleClient();
              const signRes = await client.signTypedData({ walletId: feeWalletId, data: JSON.stringify(eip712Data) });
              signature = (signRes.data as any)?.signature;
            } else {
              const pk = process.env.PRIVATE_KEY;
              if (!pk) {
                res.writeHead(500); res.end(JSON.stringify({ error: 'PRIVATE_KEY not configured for server signing' })); return;
              }
              const formattedPk = (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`;
              const account = privateKeyToAccount(formattedPk);
              signature = await account.signTypedData({
                domain: eip712Data.domain,
                types: eip712Data.types as any,
                primaryType: 'BurnIntent',
                message: {
                  maxBlockHeight: BigInt(estimated.maxBlockHeight),
                  maxFee: maxFeeBuffered,
                  spec: { ...formattedSpec, value: BigInt(formattedSpec.value) },
                },
              });
            }

            burnIntentSpec = {
              maxBlockHeight: estimated.maxBlockHeight.toString(),
              maxFee: maxFeeBuffered.toString(),
              spec: formattedSpec,
            };
          }

          const transferRes = await fetch(`${GATEWAY_FACILITATOR_URL}/v1/transfer?enableForwarder=true`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([{ burnIntent: burnIntentSpec, signature }]),
          });

          const transferData = await transferRes.json();
          if (!transferRes.ok) {
            res.writeHead(transferRes.status);
            res.end(JSON.stringify({ error: transferData?.message ?? 'Circle Gateway transfer failed', detail: transferData }));
            return;
          }

          const transferId = transferData?.transferId;
          let finalStatus = 'pending';
          let pollDetail: any = null;

          if (transferId) {
            for (let attempt = 0; attempt < 5; attempt++) {
              await new Promise((r) => setTimeout(r, 2000));
              try {
                const pollRes = await fetch(`${GATEWAY_FACILITATOR_URL}/v1/transfer/${transferId}`);
                if (pollRes.ok) {
                  pollDetail = await pollRes.json();
                  finalStatus = pollDetail?.status || 'pending';
                  if (finalStatus === 'completed' || finalStatus === 'failed') break;
                }
              } catch (pollErr) {
                console.warn('[gateway-withdraw] Polling error:', pollErr);
              }
            }
          }

          if (finalStatus === 'failed') {
            const failureReason = pollDetail?.forwardingDetails?.failureReason || 'ON_CHAIN_FAILURE';
            res.writeHead(400);
            res.end(JSON.stringify({
              error: `Circle Gateway Forwarder relayer failed to execute on-chain (${failureReason}). Your funds were NOT deducted and remain safe in your Gateway balance.`,
              status: 'failed',
              transferId,
              detail: pollDetail,
            }));
            return;
          }

          res.writeHead(200);
          res.end(JSON.stringify({ ...transferData, status: finalStatus, pollDetail }));
        } catch (err: any) {
          res.writeHead(500); res.end(JSON.stringify({ error: err.message || 'Internal server error' }));
        }
      });
      return;
    }
  }

  // ── Agent Deploy endpoint ─────────────────────────────────────────────────
  // POST /agents/deploy — starts an SMC executor daemon for a user.
  // Auth: Circle W3S Bearer token in Authorization header (same as /dispatch).
  // Security: address is derived from Circle's API response, never from a caller-supplied header.

  if (req.method === 'POST' && parsedUrl.pathname === '/agents/deploy') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { agentId, intervalSeconds, agentWalletId } = JSON.parse(body) as {
          agentId: string;
          intervalSeconds?: number;
          /** Circle walletId of the user's Agent Wallet (EOA) — supplied by the frontend from listWallets */
          agentWalletId?: string;
        };

        console.log(`\n[deploy-step-1] Starting /agents/deploy request... Timestamp: ${new Date().toISOString()}`);

        // 1. Verify caller identity via Circle token — address comes from Circle, not from headers
        let verifiedAddress: string;
        let verifiedUserId: string;
        try {
          console.log(`[deploy-step-1a] Calling verifyRequestAuth...`);
          const authResult = await verifyRequestAuth(req.headers as Record<string, string | string[] | undefined>);
          verifiedAddress = authResult.walletAddress;
          verifiedUserId  = authResult.userId;
          console.log(`[deploy-step-1-ok] Auth verified: address=${verifiedAddress}, userId=${verifiedUserId}`);
        } catch (authErr: any) {
          console.error(`[deploy-step-1-fail] Auth verification failed: ${authErr.message}`);
          res.writeHead(401);
          res.end(JSON.stringify({ success: false, error: `Unauthorized: ${authErr.message}` }));
          return;
        }

        // 2. Validate agentId — only SMC Alpha Executor has a daemon loop today
        const supportedDaemonAgents = ['agent_smc_alpha_executor', 'agent_risk_rebalancer', 'agent_crossdex_arb'];
        if (!agentId || (!supportedDaemonAgents.includes(agentId) && !agentRegistry[agentId])) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: `Agent "${agentId}" is invalid or does not support daemon loops.` }));
          return;
        }


        // 3. Resolve userRefId and Fee Wallet first — license check uses Fee Wallet address
        const userRefId = verifiedUserId || verifiedAddress;
        console.log(`[deploy-step-3] Resolving Fee Wallet for refId "${userRefId}" to check license against it...`);
        let feeWallet: { address: string; id: string };
        try {
          feeWallet = await getOrAssignFeeWallet(userRefId);
          console.log(`[deploy-step-3-wallet] Fee Wallet: ${feeWallet.address} (id=${feeWallet.id})`);
        } catch (feeErr: any) {
          console.error(`[deploy-step-3-fail] Fee Wallet provisioning failed: ${feeErr.message}`);
          res.writeHead(503);
          res.end(JSON.stringify({ success: false, error: `Fee Wallet provisioning failed: ${feeErr.message}` }));
          return;
        }

        // License must be held by the Fee Wallet, not the User-Controlled wallet.
        // Purchases from the new /agents/purchase endpoint write userLicenses[feeWallet.address][agentId] = true.
        console.log(`[deploy-step-3] Checking license on-chain for FeeWallet=${feeWallet.address} & UserAddress=${verifiedAddress} / ${agentId}... (MOCK_AUTH_ENABLED=${MOCK_AUTH_ENABLED})`);
        let licensed = false;
        try {
          if (MOCK_AUTH_ENABLED) {
            licensed = true;
          } else {
            // Check feeWallet first, then fallback to user address
            try {
              licensed = await verifyUserLicense(feeWallet.address as Address, agentId);
            } catch (err) {
              console.warn(`[deploy-step-3] Fee wallet license check failed, checking user address...`);
            }

            if (!licensed && verifiedAddress) {
              try {
                licensed = await verifyUserLicense(verifiedAddress as Address, agentId);
              } catch (err) {
                console.warn(`[deploy-step-3] User address license check failed.`);
              }
            }

            // Fallback: scan recent AgentPurchased events for this feeWallet or userAddress
            if (!licensed) {
              try {
                console.log(`[deploy-step-3] RPC userLicenses returned false — scanning AgentPurchased events as fallback...`);
                const purchaseLogs = await publicClient.getLogs({
                  address: process.env.MARKETPLACE_ADDRESS as Address,
                  event: {
                    type: 'event',
                    name: 'AgentPurchased',
                    inputs: [
                      { name: 'buyer', type: 'address', indexed: true },
                      { name: 'agentId', type: 'string', indexed: true },
                      { name: 'totalPaid', type: 'uint256', indexed: false },
                    ],
                  },
                  args: { buyer: feeWallet.address as Address },
                  fromBlock: 'earliest',
                  toBlock: 'latest',
                });
                if (purchaseLogs.length > 0) {
                  console.log(`[deploy-step-3] Found ${purchaseLogs.length} AgentPurchased event(s) for feeWallet — granting license.`);
                  licensed = true;
                }
              } catch (eventErr) {
                console.warn(`[deploy-step-3] AgentPurchased event scan also failed:`, eventErr);
              }
            }
          }
          console.log(`[deploy-step-3-ok] License check result: licensed=${licensed}`);
        } catch (licenseErr: any) {
          // Best-effort: if ALL checks fail due to RPC, allow deploy to proceed
          // The on-chain nanopayment fee deduction is the real economic guard
          console.error(`[deploy-step-3-fail] License verification RPC error — proceeding anyway (best-effort):`, licenseErr);
          licensed = true;
        }

        if (!licensed) {
          console.warn(`[/agents/deploy] License denied: feeWallet=${feeWallet.address} → ${agentId}`);
          res.writeHead(402);
          res.end(JSON.stringify({
            success: false,
            error: `No active license for agent "${agentId}". Purchase a license in the Marketplace first.`,
          }));
          return;
        }

        // 4. Assign Developer-Controlled Trading Wallet (Fee Wallet already resolved above)
        console.log(`[deploy-step-4] Resolving / assigning Trading Wallet for refId "${userRefId}"...`);
        let tradingWallet: { address: string; id: string };

        try {
          tradingWallet = await getOrAssignTradingWallet(userRefId);
          console.log(`[deploy-step-4-ok] Trading Wallet: ${tradingWallet.address} (id=${tradingWallet.id}) | Fee Wallet (already resolved): ${feeWallet.address}`);
        } catch (walletErr: any) {
          console.error(`[deploy-step-4-fail] Trading Wallet assignment failed: ${walletErr.message}`);
          res.writeHead(503);
          res.end(JSON.stringify({ success: false, error: `Wallet assignment failed: ${walletErr.message}` }));
          return;
        }


        // 5. Start (or no-op if already running) the daemon loop
        console.log(`[deploy-step-5] Starting daemon loop...`);
        const interval = (intervalSeconds && intervalSeconds > 0) ? intervalSeconds : 300;
        const { entry: daemonEntry, alreadyExisted } = startDaemon(
          verifiedAddress,
          userRefId,
          tradingWallet.address,
          interval,
          agentId,
          feeWallet.id,
        );

        console.log(
          `[deploy-step-5-ok] ✅ Daemon active for ${verifiedAddress} | ` +
          `tradingWallet: ${tradingWallet.address} | feeWallet: ${feeWallet.address} | interval: ${interval}s (alreadyExisted: ${alreadyExisted})\n`
        );

        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          agentId,
          userAddress: verifiedAddress,
          tradingWalletAddress: tradingWallet.address,
          feeWalletAddress: feeWallet.address,
          intervalSeconds: interval,
          daemonStartedAt: daemonEntry.startedAt,
          alreadyRunning: alreadyExisted,
        }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: err.message || 'Invalid JSON body' }));
      }
    });
    return;
  }

  // ── Agent Status endpoint ─────────────────────────────────────────────────
  // GET /agents/status?userAddress=0x... — returns daemon status for a user.
  // GET /agents/status                  — returns all active daemons (admin view).
  if (req.method === 'GET' && parsedUrl.pathname === '/agents/status') {
    const queryAddress = parsedUrl.searchParams.get('userAddress');
    if (queryAddress) {
      const status = getDaemonStatus(queryAddress);
      if (!status) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ running: false, userAddress: queryAddress.toLowerCase() }));
        return;
      }
      const agentId = status.agentId || 'agent_smc_alpha_executor';
      const latestDecision = getLatestSharedDecision(agentId);
      const activePosition = getPosition(status.userRefId || queryAddress);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...status,
        latestDecision: latestDecision ?? null,
        activePosition: activePosition ?? null,
      }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ daemons: listDaemons(), count: listDaemons().length }));
    }
    return;
  }

  // ── Agent Stop endpoint ───────────────────────────────────────────────────
  // POST /agents/stop — stops a running daemon. Requires same Circle auth as /agents/deploy.
  if (req.method === 'POST' && parsedUrl.pathname === '/agents/stop') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        let verifiedAddress: string;
        try {
          const authResult = await verifyRequestAuth(req.headers as Record<string, string | string[] | undefined>);
          verifiedAddress = authResult.walletAddress;
        } catch (authErr: any) {
          res.writeHead(401);
          res.end(JSON.stringify({ success: false, error: `Unauthorized: ${authErr.message}` }));
          return;
        }

        const stopped = stopDaemon(verifiedAddress);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, stopped, userAddress: verifiedAddress }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: err.message || 'Invalid body' }));
      }
    });
    return;
  }

  // ── Trading Wallet Status endpoint ──────────────────────────────────────────
  // GET /agents/trading-wallet?userAddress=0x... — returns trading wallet address & balance
  if (req.method === 'GET' && parsedUrl.pathname === '/agents/trading-wallet') {
    const queryAddress = parsedUrl.searchParams.get('userAddress');
    if (!queryAddress) {
      res.writeHead(400);
      res.end(JSON.stringify({ success: false, error: 'Missing required searchParam: userAddress' }));
      return;
    }

    const userRefId = queryAddress.toLowerCase();
    Promise.all([
      getOrAssignTradingWallet(userRefId),
      getOrAssignFeeWallet(userRefId),
    ])
      .then(async ([tw, fw]) => {
        if (!tw && !fw) {
          res.writeHead(200);
          res.end(JSON.stringify({
            provisioned: false,
            tradingWalletAddress: null,
            balance: "0.00",
            feeWalletAddress: null,
            feeWalletBalance: "0.00",
          }));
          return;
        }

        const EURC_ARC_ADDR = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a' as Address;
        const CIRBTC_ARC_ADDR = '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF' as Address;

        const fetchMultiTokenBals = async (walletObj: any) => {
          if (!walletObj?.address) {
            return {
              usdc: "0.00",
              eurc: "0.00",
              cirbtc: "0.00000000",
              holdings: [
                { symbol: 'USDC', name: 'USD Coin', balance: '0.00', address: USDC_ADDRESS_ARC },
                { symbol: 'EURC', name: 'Euro Coin', balance: '0.00', address: EURC_ARC_ADDR },
                { symbol: 'cirBTC', name: 'Circle Wrapped Bitcoin', balance: '0.00000000', address: CIRBTC_ARC_ADDR },
              ]
            };
          }

          const addr = walletObj.address as Address;
          const erc20Abi = parseAbi(['function balanceOf(address account) view returns (uint256)']);

          const [rawUsdc, rawEurc, rawCirbtc] = await Promise.all([
            publicClient.readContract({ address: USDC_ADDRESS_ARC as Address, abi: erc20Abi, functionName: 'balanceOf', args: [addr] }).catch(() => 0n),
            publicClient.readContract({ address: EURC_ARC_ADDR, abi: erc20Abi, functionName: 'balanceOf', args: [addr] }).catch(() => 0n),
            publicClient.readContract({ address: CIRBTC_ARC_ADDR, abi: erc20Abi, functionName: 'balanceOf', args: [addr] }).catch(() => 0n),
          ]);

          const usdc = (Number(rawUsdc) / 1e6).toFixed(6);
          const eurc = (Number(rawEurc) / 1e6).toFixed(6);
          const cirbtc = (Number(rawCirbtc) / 1e8).toFixed(8);

          return {
            usdc,
            eurc,
            cirbtc,
            holdings: [
              { symbol: 'USDC', name: 'USD Coin', balance: usdc, address: USDC_ADDRESS_ARC },
              { symbol: 'EURC', name: 'Euro Coin', balance: eurc, address: EURC_ARC_ADDR },
              { symbol: 'cirBTC', name: 'Circle Wrapped Bitcoin', balance: cirbtc, address: CIRBTC_ARC_ADDR },
            ]
          };
        };

        const [twData, fwData] = await Promise.all([
          fetchMultiTokenBals(tw),
          fetchMultiTokenBals(fw),
        ]);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          provisioned: !!tw,
          tradingWalletAddress: tw?.address ?? null,
          tradingWalletId: tw?.id ?? null,
          balance: twData.usdc,
          holdings: twData.holdings,
          feeWalletProvisioned: !!fw,
          feeWalletAddress: fw?.address ?? null,
          feeWalletId: fw?.id ?? null,
          feeWalletBalance: fwData.usdc,
        }));
      })
      .catch((err: any) => {
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: err.message }));
      });
    return;
  }

  // ── Trading Wallet Fund endpoint ──────────────────────────────────────────────
  // POST /agents/trading-wallet/fund — transfers USDC from Fee Wallet to Trading Wallet server-side.
  if (req.method === 'POST' && parsedUrl.pathname === '/agents/trading-wallet/fund') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        let verifiedAddress: string;
        let verifiedUserId: string;
        try {
          const authResult = await verifyRequestAuth(req.headers as Record<string, string | string[] | undefined>);
          verifiedAddress = authResult.walletAddress;
          verifiedUserId = authResult.userId;
        } catch (authErr: any) {
          res.writeHead(401);
          res.end(JSON.stringify({ success: false, error: `Unauthorized: ${authErr.message}` }));
          return;
        }

        const { amountUsdc, amount } = JSON.parse(body) as { amountUsdc?: string; amount?: string };
        const fundAmount = amountUsdc || amount || '0';
        if (!fundAmount || parseFloat(fundAmount) <= 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'Valid amount is required' }));
          return;
        }

        const userRefId = verifiedUserId || verifiedAddress;
        const feeWallet = await getOrAssignFeeWallet(userRefId);
        const tradingWallet = await getOrAssignTradingWallet(userRefId);

        const amountAtomic = BigInt(Math.round(parseFloat(fundAmount) * 1_000_000));
        const USDC_ADDR = (process.env.USDC_ADDRESS ?? '0x3600000000000000000000000000000000000000') as Address;
        
        const { encodeFunctionData } = await import('viem');
        const transferCalldata = encodeFunctionData({
          abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
          functionName: 'transfer',
          args: [tradingWallet.address as Address, amountAtomic],
        });

        let signer = ethersWallet;
        if ((feeWallet as any).privateKey) {
          signer = new ethers.Wallet((feeWallet as any).privateKey, ethersProvider);
        }

        console.log(`[trading-wallet/fund] Transferring ${fundAmount} USDC from Fee Wallet ${feeWallet.address} to Trading Wallet ${tradingWallet.address}...`);
        const txResponse = await signer.sendTransaction({
          to: USDC_ADDR,
          data: transferCalldata,
        });
        const receipt = await txResponse.wait();
        const txHash = receipt?.hash || txResponse.hash;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, txHash, feeWalletAddress: feeWallet.address, tradingWalletAddress: tradingWallet.address }));
      } catch (err: any) {
        console.error('[/agents/trading-wallet/fund] Error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message || 'Internal server error' }));
      }
    });
    return;
  }

  // ── Trading Wallet Withdraw endpoint ─────────────────────────────────────────
  // POST /agents/trading-wallet/withdraw — withdraws USDC from Trading Wallet to user's Agent Wallet.
  // Security: Requires Circle Authorization header (verifiedAddress).
  if (req.method === 'POST' && parsedUrl.pathname === '/agents/trading-wallet/withdraw') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        let verifiedAddress: string;
        let verifiedUserId: string;
        try {
          const authResult = await verifyRequestAuth(req.headers as Record<string, string | string[] | undefined>);
          verifiedAddress = authResult.walletAddress;
          verifiedUserId = authResult.userId;
        } catch (authErr: any) {
          res.writeHead(401);
          res.end(JSON.stringify({ success: false, error: `Unauthorized: ${authErr.message}` }));
          return;
        }

        const { amount, destinationAddress } = JSON.parse(body) as {
          amount: string;
          destinationAddress?: string;
          idempotencyKey?: string; // ignored — server generates UUID internally
        };

        if (!amount || parseFloat(amount) <= 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'Valid amount greater than zero is required.' }));
          return;
        }

        const targetDest = (destinationAddress && /^0x[a-fA-F0-9]{40}$/.test(destinationAddress))
          ? destinationAddress
          : verifiedAddress;

        const userRefId = verifiedUserId || verifiedAddress;
        const result = await withdrawFromTradingWallet({
          userRefId,
          destinationAddress: targetDest,
          amount,
        });

        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          amount,
          destinationAddress: targetDest,
          txHash: result.txHash ?? null,
          id: result.id ?? null,
        }));
      } catch (err: any) {
        console.error('[dispatcher] Trading Wallet withdrawal error:', err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: err.message || 'Withdrawal failed' }));
      }
    });
    return;
  }

  // ── Fee Wallet Withdraw endpoint ─────────────────────────────────────────────
  // POST /agents/fee-wallet/withdraw — withdraws USDC from Fee Wallet to target destination.
  // Security: Requires Circle Authorization header (verifiedAddress).
  if (req.method === 'POST' && parsedUrl.pathname === '/agents/fee-wallet/withdraw') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        let verifiedAddress: string;
        let verifiedUserId: string;
        try {
          const authResult = await verifyRequestAuth(req.headers as Record<string, string | string[] | undefined>);
          verifiedAddress = authResult.walletAddress;
          verifiedUserId = authResult.userId;
        } catch (authErr: any) {
          res.writeHead(401);
          res.end(JSON.stringify({ success: false, error: `Unauthorized: ${authErr.message}` }));
          return;
        }

        const { amount, destinationAddress } = JSON.parse(body) as {
          amount: string;
          destinationAddress?: string;
          idempotencyKey?: string; // ignored — server generates UUID internally
        };

        if (!amount || parseFloat(amount) <= 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'Valid amount greater than zero is required.' }));
          return;
        }

        const targetDest = (destinationAddress && /^0x[a-fA-F0-9]{40}$/.test(destinationAddress))
          ? destinationAddress
          : verifiedAddress;

        const userRefId = verifiedUserId || verifiedAddress;
        const result = await withdrawFromFeeWallet({
          userRefId,
          destinationAddress: targetDest,
          amount,
        });

        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          amount,
          destinationAddress: targetDest,
          txHash: result.txHash ?? null,
          id: result.id ?? null,
        }));
      } catch (err: any) {
        console.error('[dispatcher] Fee Wallet withdrawal error:', err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: err.message || 'Withdrawal failed' }));
      }
    });
    return;
  }

  // Dispatch endpoint
  if (req.method === 'POST' && parsedUrl.pathname === '/dispatch') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload: DispatchRequest = JSON.parse(body);
        const { statusCode, payload: responsePayload } = await dispatch(payload, req.headers);
        res.writeHead(statusCode);
        res.end(JSON.stringify(responsePayload));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: err.message || 'Invalid JSON body' }));
      }
    });
    return;
  }

  // Settle endpoint for Light Agents (EIP-3009 signature submission)
  if (req.method === 'POST' && parsedUrl.pathname === '/dispatch/settle') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { jobId, paymentPayload } = JSON.parse(body);
        if (!jobId || !paymentPayload) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'Missing required fields: jobId, paymentPayload' }));
          return;
        }

        // Authenticate the user
        let verifiedAddress: string;
        try {
          const authResult = await verifyRequestAuth(req.headers as Record<string, string | string[] | undefined>);
          verifiedAddress = authResult.walletAddress;
        } catch (authErr: any) {
          res.writeHead(401);
          res.end(JSON.stringify({ success: false, error: `Unauthorized: ${authErr.message}` }));
          return;
        }

        // Look up the job
        const job = pendingJobs.get(jobId);
        if (!job) {
          console.warn(`[free-ride attempt] Settle attempt on expired or purged job: ${jobId}`);
          res.writeHead(404);
          res.end(JSON.stringify({ success: false, error: 'Pending job not found or expired.' }));
          return;
        }

        // Check ownership
        if (job.buyerAddress.toLowerCase() !== verifiedAddress.toLowerCase()) {
          res.writeHead(403);
          res.end(JSON.stringify({ success: false, error: 'Forbidden: you do not own this pending job.' }));
          return;
        }

        // Settle EIP-3009 payment
        const requirements = {
          scheme: 'exact',
          network: 'eip155:5042002',
          asset: USDC_ADDRESS_ARC,
          amount: job.actualCostAtomic,
          payTo: ENGINE_WALLET_ADDRESS,
          maxTimeoutSeconds: 604900,
          extra: {
            name: 'GatewayWalletBatched',
            version: '1',
            verifyingContract: GATEWAY_WALLET_ADDRESS,
          },
        };

        console.log(`[dispatcher] Settling payment for job: ${jobId}, actual cost: ${ethers.formatUnits(job.actualCostAtomic, 6)} USDC`);
        const settleResult = await settlePaymentWithRetry(paymentPayload, requirements);

        // Crash recovery: mark as settled first
        job.settled = true;
        job.settleTx = settleResult.transaction;
        savePendingJobs(pendingJobs);

        // Update mock balances if mock mode active
        if (MOCK_AUTH_ENABLED) {
          const key = job.buyerAddress.toLowerCase();
          const cur = mockBalances.get(key) ?? 5000n;
          mockBalances.set(key, cur - BigInt(job.actualCostAtomic));
          console.log(`[dispatcher] [MOCK] Balance of ${key} after settle: ${mockBalances.get(key)!} atomic units.`);
        }

        // Save chat message — use job.userId (persisted auth identity) not buyerAddress
        saveChatMessage(job.userId ?? job.buyerAddress, job.buyerAddress, job.agentId, 'agent', job.result);
        recordSpend({ userAddress: job.buyerAddress, amountAtomic: BigInt(job.actualCostAtomic), targetAddress: job.agentId });

        // Remove from map
        pendingJobs.delete(jobId);
        // Clear completely from JSON file
        savePendingJobs(pendingJobs);

        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          result: job.result,
          logs: job.logs
        }));

      } catch (err: any) {
        console.error(`[dispatcher] Settle endpoint error: ${err.message}`);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: `Settlement failed: ${err.message}` }));
      }
    });
    return;
  }

  // History endpoint
  if (req.method === 'GET' && parsedUrl.pathname === '/history') {
    const agentId = parsedUrl.searchParams.get('agentId') ?? '';
    if (!agentId) {
      res.writeHead(400);
      res.end(JSON.stringify({ success: false, error: 'Missing required param: agentId' }));
      return;
    }

    let historyAddress: string;
    let historyUserId: string;
    try {
      const authResult = await verifyRequestAuth(req.headers as Record<string, string | string[] | undefined>);
      historyAddress = authResult.walletAddress;
      historyUserId = authResult.userId;
    } catch (authErr: any) {
      res.writeHead(401);
      res.end(JSON.stringify({ success: false, error: `Unauthorized: ${authErr.message}` }));
      return;
    }

    try {
      let licensed = false;
      if (MOCK_AUTH_ENABLED) {
        licensed = true;
      } else {
        licensed = await verifyUserLicense(historyAddress as Address, agentId);
      }
      if (!licensed) {
        res.writeHead(403);
        res.end(JSON.stringify({ success: false, error: `Forbidden: no active license for agent "${agentId}".` }));
        return;
      }
    } catch {
      res.writeHead(503);
      res.end(JSON.stringify({ success: false, error: 'License verification temporarily unavailable.' }));
      return;
    }

    console.log(`[dispatcher] GET /history — Verified Identity: userId=${historyUserId} | walletAddress=${historyAddress} | agentId=${agentId}`);
    const thread = getChatHistory(historyUserId, historyAddress, agentId);
    console.log(`[dispatcher] GET /history — Returning thread with ${thread.length} messages for userId=${historyUserId}`);
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, agentId, thread }));
    return;
  }

  // Debug endpoint
  if (MOCK_AUTH_ENABLED && req.method === 'GET' && parsedUrl.pathname === '/debug/queue-size') {
    const keys = Array.from(userDispatchQueues.keys());
    res.writeHead(200);
    res.end(JSON.stringify({ size: keys.length, keys }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found. POST /dispatch, POST /dispatch/settle, GET /status, GET /history or GET /health' }));
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[dispatcher] ✗ Port ${PORT} is already in use.`);
    process.exit(1);
  } else {
    throw err;
  }
});

server.on('close', () => {
  // Save state on server close
  savePendingJobs(pendingJobs);
});

server.listen(PORT, () => {
  console.log(`\n╔═════════════════════════════════════════════════════╗`);
  console.log(`║        Æthel Engine — Dispatcher Service            ║`);
  console.log(`╚═════════════════════════════════════════════════════╝`);
  console.log(`  Listening on http://localhost:${PORT}`);
  console.log(`  POST /dispatch          → verify balance + execute agent`);
  console.log(`  POST /dispatch/settle   → settle payment and release result`);
  console.log(`  GET  /status            → check execution logs & result`);
  console.log(`  GET  /health            → service health check`);
  console.log(`  POST /agents/deploy     → start SMC executor daemon (Circle auth + license check)`);
  console.log(`  POST /agents/stop       → stop a running daemon (Circle auth)`);
  console.log(`  GET  /agents/status     → daemon status (all or ?userAddress=0x...)\n`);
});


export default server;
