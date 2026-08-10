/**
 * payment-utils.ts
 *
 * Viem-based utilities for verifying that a marketplace escrow payment
 * has been confirmed on the ARC Testnet before routing to an agent.
 *
 * Chain: ARC Testnet (chainId 5042002)
 * Contract: Æthel Marketplace Proxy (UUPS)
 * Token: USDC (6 decimals)
 */

import 'dotenv/config';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  parseAbi,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { BatchEvmScheme } from '@circle-fin/x402-batching/client';
import { BatchFacilitatorClient } from '@circle-fin/x402-batching/server';
import { getCircleClient } from './trading-wallet';

// Enable global JSON.stringify serialization for BigInt across EIP-712 & x402 payloads
if (!(BigInt.prototype as any).toJSON) {
  (BigInt.prototype as any).toJSON = function () {
    return this.toString();
  };
}

// ── Environment Validation (fail loudly on startup if required vars are missing) ─

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`[payment-utils] Missing required environment variable: ${key}. Set it in ENGINE/.env before starting.`);
  return val;
}

// ── Chain Definition ──────────────────────────────────────────────────────────

const RPC_URL    = requireEnv('RPC_URL');
const CHAIN_ID   = parseInt(requireEnv('CHAIN_ID'), 10);

export const arcTestnet = {
  id: CHAIN_ID,
  name: process.env.CHAIN_NAME ?? 'ARC Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: {
    default: { http: [RPC_URL] },
    public: { http: [RPC_URL] },
  },
} as const;

export const publicClient = createPublicClient({
  chain: arcTestnet as any,
  transport: http(RPC_URL),
});

// ── Contract Addresses ────────────────────────────────────────────────────────

export const MARKETPLACE_ADDRESS = requireEnv('MARKETPLACE_ADDRESS') as Address;
export const USDC_ADDRESS        = requireEnv('USDC_ADDRESS') as Address;

// ── ABIs ──────────────────────────────────────────────────────────────────────

export const MARKETPLACE_ABI = parseAbi([
  // Emitted when a buyer completes a purchase
  'event AgentPurchased(address indexed buyer, string indexed agentId, uint256 totalPaid)',
  // Emitted when a developer lists an agent
  'event AgentListed(string indexed agentId, uint256 price, uint256 stakedAmount, string metadataUri, address indexed developer, address engineWallet)',
  // Emitted when owner grants a license directly (migration)
  'event LicenseGranted(address indexed user, string indexed agentId)',
  // Read agent registry entry by string ID — V2 struct layout:
  // (agentId, creator, engineWallet, price, stakedAmount, recurringFeeBps, status, metadataUri)
  // status: 0=PendingApproval, 1=Approved, 2=Delisted, 3=Suspended
  'function marketRegistry(string agentId) view returns (string agentId, address creator, address engineWallet, uint256 price, uint256 stakedAmount, uint256 recurringFeeBps, uint8 status, string metadataUri)',
  // Purchase function — buyer calls this, USDC is transferred to escrow
  'function purchaseAgent(string agentId) external',
  // Access ledger: true if the user holds an active license for this agentId
  'function userLicenses(address user, string agentId) view returns (bool)',
  // USDC approve needed before purchaseAgent
  'function approve(address spender, uint256 amount) external returns (bool)',
]);

export const USDC_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function balanceOf(address account) view returns (uint256)',
]);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EscrowVerificationResult {
  /** Whether the payment has been successfully confirmed on-chain */
  verified: boolean;
  /** The agent ID decoded from the purchase transaction */
  agentId: string | null;
  /** The amount paid in USDC (6-decimal raw value) */
  totalPaid: bigint | null;
  /** The buyer wallet address */
  buyer: Address | null;
  /** Human-readable USDC amount (e.g. "5.00") */
  amountDisplay: string | null;
  /** Block number the transaction was included in */
  blockNumber: bigint | null;
  /** Error message if verification failed */
  error?: string;
}

// ── Core Utility: verifyEscrowPayment ────────────────────────────────────────

/**
 * Verifies that a given transaction hash corresponds to a successful
 * AgentPurchased event for a specific agentId on the Æthel marketplace.
 *
 * Steps:
 *  1. Fetch the transaction receipt from the ARC Testnet.
 *  2. Parse logs for an `AgentPurchased` event emitted by the marketplace.
 *  3. Confirm the agentId in the event matches the expected agentId.
 *  4. Optionally confirm the buyer address matches.
 *  5. Confirm the transaction reverted-status is success (status === 'success').
 *
 * @param txHash - The on-chain transaction hash to verify
 * @param expectedAgentId - The agent ID the buyer was supposed to purchase
 * @param expectedBuyer - (optional) The expected buyer wallet address
 * @returns EscrowVerificationResult
 */
export async function verifyEscrowPayment(
  txHash: Hash,
  expectedAgentId: string,
  expectedBuyer?: Address
): Promise<EscrowVerificationResult> {
  const notFound: EscrowVerificationResult = {
    verified: false,
    agentId: null,
    totalPaid: null,
    buyer: null,
    amountDisplay: null,
    blockNumber: null,
  };

  try {
    // ── Step 1: Fetch transaction receipt ─────────────────────────────────────
    let receipt: TransactionReceipt;
    try {
      receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    } catch (err) {
      return {
        ...notFound,
        error: `Transaction not found or not yet mined: ${txHash}`,
      };
    }

    // ── Step 2: Check transaction success ─────────────────────────────────────
    if (receipt.status !== 'success') {
      return {
        ...notFound,
        error: `Transaction ${txHash} reverted (status: ${receipt.status})`,
      };
    }

    // ── Step 3: Parse AgentPurchased events from receipt logs ─────────────────
    // Filter logs from the marketplace contract only
    const marketplaceLogs = receipt.logs.filter(
      (log) => log.address.toLowerCase() === MARKETPLACE_ADDRESS.toLowerCase()
    );

    if (marketplaceLogs.length === 0) {
      return {
        ...notFound,
        error: `No marketplace events found in transaction ${txHash}`,
      };
    }

    // Decode each log looking for AgentPurchased
    for (const log of marketplaceLogs) {
      try {
        const decoded = decodeEventLog({
          abi: MARKETPLACE_ABI,
          data: log.data,
          topics: log.topics,
        }) as {
          eventName: string;
          args: {
            buyer: Address;
            agentId: string;
            totalPaid: bigint;
          };
        };

        if (decoded.eventName !== 'AgentPurchased') continue;

        const { buyer, agentId, totalPaid } = decoded.args;

        // ── Step 4: Verify agentId matches ─────────────────────────────────────
        // Note: agentId is indexed, so on-chain it's stored as a keccak256 hash.
        // We compare the raw decoded value. If your contract stores the hash,
        // fall back to checking the transaction input data (see dispatcher.ts).
        if (agentId !== expectedAgentId) {
          continue; // This log is for a different agent — keep scanning
        }

        // ── Step 5: Optionally verify buyer ────────────────────────────────────
        if (
          expectedBuyer &&
          buyer.toLowerCase() !== expectedBuyer.toLowerCase()
        ) {
          return {
            ...notFound,
            error: `Buyer mismatch: expected ${expectedBuyer}, found ${buyer}`,
          };
        }

        // ── Step 6: All checks passed ───────────────────────────────────────────
        const usdcDecimals = 6;
        const amountDisplay = (Number(totalPaid) / 10 ** usdcDecimals).toFixed(2);

        return {
          verified: true,
          agentId,
          totalPaid,
          buyer,
          amountDisplay,
          blockNumber: receipt.blockNumber,
        };
      } catch {
        // Log couldn't be decoded as AgentPurchased — skip
        continue;
      }
    }

    return {
      ...notFound,
      error: `AgentPurchased event for agent "${expectedAgentId}" not found in tx ${txHash}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...notFound,
      error: `Verification failed: ${message}`,
    };
  }
}

// ── Utility: Fetch Agent Registry Entry ──────────────────────────────────────

/**
 * Reads the on-chain marketRegistry for a given agentId.
 * Returns null if the agent is not listed or not found.
 */
export async function getAgentRegistryEntry(agentId: string) {
  try {
    const result =
      (await publicClient.readContract({
        address: MARKETPLACE_ADDRESS,
        abi: MARKETPLACE_ABI,
        functionName: 'marketRegistry',
        args: [agentId],
      })) as [string, Address, Address, bigint, bigint, bigint, number, string];

    const [id, creator, , price, , , , metadataUri] = result;

    // creator == address(0) means the agent was never listed via listAgent().
    // For preset/legacy agents granted via grantLicense(), marketRegistry won't
    // have an entry — that's fine. We fall back to the agentId itself so the
    // ENGINE can still resolve price/metadata from its local agentRegistry.
    const isPreset = !creator || creator === '0x0000000000000000000000000000000000000000';

    let title = id || agentId;
    let description = '';
    let icon = '';
    try {
      const parsed = JSON.parse(metadataUri);
      title = parsed.title ?? title;
      description = parsed.description ?? '';
      icon = parsed.icon ?? '';
    } catch {
      title = metadataUri || title;
    }

    return {
      agentId: id || agentId,
      creator: creator ?? null,
      price: isPreset ? 0n : price,
      isListed: !isPreset,
      isPreset,
      metadataUri: metadataUri ?? '',
      title,
      description,
      icon,
      priceDisplay: isPreset ? '0.00' : (Number(price) / 1_000_000).toFixed(2),
    };
  } catch {
    // RPC failure — return a minimal stub so deploy can continue if license is valid
    return {
      agentId,
      creator: null,
      price: 0n,
      isListed: false,
      isPreset: true,
      metadataUri: '',
      title: agentId,
      description: '',
      icon: '',
      priceDisplay: '0.00',
    };
  }
}


// ── License Verification ─────────────────────────────────────────────────────

/**
 * Verifies on-chain that `buyer` holds an active license for `agentId`.
 * Retries up to 3 times with 800ms backoff to absorb Arc Testnet RPC blips.
 * Returns true if licensed, false otherwise.
 * Throws only if all retry attempts fail.
 */
export async function verifyUserLicense(
  buyer: Address,
  agentId: string,
): Promise<boolean> {
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 800;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const licensed = await publicClient.readContract({
        address: MARKETPLACE_ADDRESS,
        abi: MARKETPLACE_ABI,
        functionName: 'userLicenses',
        args: [buyer, agentId],
      }) as boolean;
      return licensed;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`[verifyUserLicense] Attempt ${attempt} failed for ${buyer}/${agentId} — retrying in ${RETRY_DELAY_MS}ms`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`License check RPC error for ${buyer}/${agentId}: ${msg}`);
}


// ── Hybrid Resource/Milestone Billing Engine ─────────────────────────────────

/**
 * Parameters for computing a resource-based agent execution fee.
 */
export interface ResourceFeeParams {
  /** Estimated number of LLM input tokens consumed (prompt length) */
  inputTokens: number;
  /** Estimated number of LLM output tokens generated (response length) */
  outputTokens: number;
  /** Number of discrete tool actions / milestone steps completed by the agent */
  milestonesCompleted: number;
  /** Per-1000-input-token rate in USDC atomic units (6-decimal) */
  inputTokenRateAtomic: bigint;
  /** Per-1000-output-token rate in USDC atomic units (6-decimal) */
  outputTokenRateAtomic: bigint;
  /** Fixed fee per milestone action in USDC atomic units (6-decimal) */
  milestoneRateAtomic: bigint;
  /**
   * Accumulated fee already charged in this session (atomic units).
   * Used to enforce the daily session cap.
   */
  sessionAccumulatedAtomic?: bigint;
  /**
   * Maximum total fee allowed for a single user session (atomic units).
   * Defaults to SESSION_CAP_ATOMIC ($1.50 USDC).
   */
  sessionCapAtomic?: bigint;
}

/**
 * Daily/session spending ceiling: $1.50 USDC (1_500_000 atomic units at 6 decimals).
 * No matter how many tasks run, a session cannot be billed more than this.
 */
export const SESSION_CAP_ATOMIC = 1_500_000n; // $1.50 USDC

/**
 * Computes the execution fee for an agent run using a hybrid
 * resource/milestone model instead of wall-clock time.
 *
 * Formula:
 *   tokenFee      = (inputTokens / 1000) * inputTokenRateAtomic
 *                 + (outputTokens / 1000) * outputTokenRateAtomic
 *   milestoneFee  = milestonesCompleted * milestoneRateAtomic
 *   rawFee        = tokenFee + milestoneFee
 *   sessionFee    = min(rawFee, max(0, sessionCap - sessionAccumulated))
 *
 * Returns the fee in atomic USDC units (6 decimals) along with a breakdown
 * and a flag indicating whether the session cap was hit.
 */
export function computeResourceFee(params: ResourceFeeParams): {
  /** Computed fee in atomic units (6-decimal USDC) */
  feeAtomic: bigint;
  /** Human-readable fee string, e.g. "0.001234" */
  feeDisplay: string;
  /** True when the session cap was reached and the fee was clamped */
  cappedBySession: boolean;
  /** Breakdown for logging */
  breakdown: {
    inputTokenFeeAtomic: bigint;
    outputTokenFeeAtomic: bigint;
    milestoneFeeAtomic: bigint;
    rawFeeAtomic: bigint;
    sessionRemainingAtomic: bigint;
  };
} {
  const {
    inputTokens,
    outputTokens,
    milestonesCompleted,
    inputTokenRateAtomic,
    outputTokenRateAtomic,
    milestoneRateAtomic,
    sessionAccumulatedAtomic = 0n,
    sessionCapAtomic = SESSION_CAP_ATOMIC,
  } = params;

  // Token fees — multiply first then divide to preserve bigint precision
  const inputTokenFeeAtomic  = (BigInt(Math.max(0, inputTokens))  * inputTokenRateAtomic)  / 1000n;
  const outputTokenFeeAtomic = (BigInt(Math.max(0, outputTokens)) * outputTokenRateAtomic) / 1000n;
  const milestoneFeeAtomic   = BigInt(Math.max(0, milestonesCompleted)) * milestoneRateAtomic;

  const rawFeeAtomic = inputTokenFeeAtomic + outputTokenFeeAtomic + milestoneFeeAtomic;

  // Session cap enforcement: remaining budget = cap - already spent this session
  const sessionRemainingAtomic =
    sessionCapAtomic > sessionAccumulatedAtomic
      ? sessionCapAtomic - sessionAccumulatedAtomic
      : 0n;

  const feeAtomic = rawFeeAtomic < sessionRemainingAtomic ? rawFeeAtomic : sessionRemainingAtomic;
  const cappedBySession = feeAtomic < rawFeeAtomic;

  // Format to 6-decimal USDC string (e.g. "0.001234")
  const feeDisplay = (Number(feeAtomic) / 1_000_000).toFixed(6);

  return {
    feeAtomic,
    feeDisplay,
    cappedBySession,
    breakdown: {
      inputTokenFeeAtomic,
      outputTokenFeeAtomic,
      milestoneFeeAtomic,
      rawFeeAtomic,
      sessionRemainingAtomic,
    },
  };
}


/**
 * Estimates LLM token count from a text string using a simple word-based
 * approximation (1 token ≈ 0.75 words, or ~4 characters per token).
 * Accurate enough for billing heuristics without requiring a tokenizer.
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ── Gateway Nanopayment: Metered Daemon Task Fee ──────────────────────────────

/**
 * EIP-3009 TransferWithAuthorization — Arc Testnet type hashes.
 * The USDC contract on Arc Testnet uses the standard FiatToken v2.2 domain.
 */
const EIP3009_TYPEHASH =
  '0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267';

const ARC_CHAIN_ID = parseInt(requireEnv('CHAIN_ID'), 10);

// Gateway spending contract address — receives authorized USDC micro-transfers
const GATEWAY_ADDRESS = requireEnv('GATEWAY_ADDRESS') as Address;

export interface TaskFeeReceipt {
  settled: boolean;
  feeDisplay: string;
  from: string;
  to: string;
  nonce: string;
  txHash?: string;
  error?: string;
}

/**
 * Deducts a metered daemon task fee from `fromAddress` to the Gateway
 * spending contract using an EIP-3009 `TransferWithAuthorization` signature.
 *
 * Flow:
 *  1. Build EIP-3009 typed-data message (off-chain authorization).
 *  2. Sign with the ENGINE private key (which controls the developer wallet).
 *  3. Submit to the Circle Gateway REST endpoint for on-chain settlement.
 *
 * Non-fatal: if settlement fails for any reason, logs a warning and returns
 * settled=false so the caller (60s daemon loop) continues without crashing.
 *
 * @param fromAddress   - Trading wallet address paying the fee
 * @param feeUSDC       - Fee amount in USDC (e.g. 0.05 for $0.05)
 */
/**
 * Deducts a machine-to-machine metered daemon task fee ($0.0001 USDC default)
 * from the AGENT WALLET (The Operator) into the GATEWAY ADDRESS (The Collector).
 *
 * Architecture:
 *  1. AGENT WALLET (The Operator): EOA created via Circle Developer-Controlled Wallets API (`accountType: 'EOA'`).
 *  2. EIP-3009 SIGNING: Builds EIP-3009 TransferWithAuthorization for $0.0001 USDC to Gateway (0x0077777...).
 *     Signs payload via Circle Developer-Controlled Wallets `signTypedData` REST API endpoint (entity secret, server-side, zero user interaction).
 *  3. x402 BATCH SETTLEMENT: Wraps into `BatchEvmSigner` interface (`{ address, signTypedData }`) and submits to
 *     Circle's `BatchEvmScheme` and `BatchFacilitatorClient` for on-chain batching and settlement.
 *  4. TRADING WALLET (The Vault): Kept strictly isolated — zero task fee leakage from principal.
 *
 * @param agentWalletAddress - User's Agent Wallet address (identity wallet; used only as EIP-3009 `from` field)
 * @param feeUSDC            - Fee amount in USDC (default 0.0001 USDC)
 * @param feeWalletId        - Circle walletId of the Developer-Controlled Fee Wallet ('aethel-fee-wallets' set).
 *                             MUST be provided. If absent, settlement is skipped with a clear warning —
 *                             the Trading Wallet is never used as a fallback (different resource pool, different purpose).
 */
export async function deductDaemonTaskFee(
  agentWalletAddress: string,
  feeUSDC: number = 0.0001,
  feeWalletId?: string,
): Promise<TaskFeeReceipt> {
  const feeDisplay = feeUSDC.toFixed(6);
  const nonce = `0x${Date.now().toString(16).padStart(64, '0')}` as `0x${string}`;

  const receipt: TaskFeeReceipt = {
    settled: false,
    feeDisplay,
    from: agentWalletAddress,
    to: GATEWAY_ADDRESS,
    nonce,
  };

  // Hard guard — only Fee Wallet (Developer-Controlled, entity-secret) can sign server-side.
  // The Trading Wallet is user principal and must not leak into fee payments.
  // The User-Controlled login wallet key share never leaves the browser.
  if (!feeWalletId) {
    receipt.error = '[TaskFee] feeWalletId not provided — daemon was started before Option Y deploy. Re-deploy via the marketplace UI to provision a Fee Wallet. Skipping settlement.';
    console.warn(receipt.error);
    return receipt;
  }

  try {
    const client = getCircleClient();

    // Resolve the fee wallet's on-chain address from Circle.
    // batchSigner.address sets message.from in the EIP-3009 payload — it MUST be the fee wallet's
    // address so that ecrecover(signature) == message.from on the Gateway verify/settle call.
    const feeWalletRes = await (client as any).getWallet({ id: feeWalletId });
    const feeWalletAddress: Address = feeWalletRes.data?.wallet?.address as Address;
    if (!feeWalletAddress) {
      throw new Error(`[TaskFee] Could not resolve on-chain address for fee wallet ${feeWalletId}`);
    }

    console.log(`[TaskFee] Signing $${feeDisplay} USDC via Fee Wallet ${feeWalletAddress} (walletId=${feeWalletId}) → Gateway (${GATEWAY_ADDRESS})...`);

    // 2. Create BatchEvmSigner that signs EIP-712 typed data via Circle REST API (server-side, entity secret)
    const batchSigner = {
      address: feeWalletAddress,
      signTypedData: async (params: any): Promise<Hex> => {
        const types = {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
          ...params.types,
        };

        const typedDataJson = JSON.stringify(
          {
            types,
            domain: params.domain,
            primaryType: params.primaryType,
            message: params.message,
          },
          (key, val) => (typeof val === 'bigint' ? val.toString() : val)
        );

        let signRes: any;
        try {
          signRes = await client.signTypedData({
            walletId: feeWalletId,
            data: typedDataJson,
          });
        } catch (signErr: any) {
          console.error('[TaskFee][SIGN_ERR] code:', signErr.code, '| status:', signErr.status, '| message:', signErr.message);
          throw signErr;
        }

        const sig = signRes.data?.signature;
        if (!sig) {
          throw new Error(`Circle signTypedData returned empty signature for fee wallet ${feeWalletId}`);
        }
        return (sig.startsWith('0x') ? sig : `0x${sig}`) as Hex;
      },
    };

    // 3. Build paymentRequirements for x402 batch scheme ($0.0001 USDC = 100 atomic units)
    const amountUnits = Math.round(feeUSDC * 1_000_000).toString();
    const paymentRequirements = {
      scheme: 'exact',
      network: `eip155:${CHAIN_ID}`,
      asset: USDC_ADDRESS,
      amount: amountUnits,
      payTo: GATEWAY_ADDRESS,
      maxTimeoutSeconds: 345600,
      extra: {
        name: 'GatewayWalletBatched',
        version: '1',
        verifyingContract: GATEWAY_ADDRESS,
      },
    };

    // 4. Create signed payment payload using BatchEvmScheme
    const scheme = new BatchEvmScheme(batchSigner);
    const payloadResult = await scheme.createPaymentPayload(1, paymentRequirements);

    const fullPayload = {
      ...(payloadResult as any),
      resource: {
        url: 'https://engine.aethel.network/daemon/cycle',
        description: 'Aethel Daemon Cycle Task Fee',
        mimeType: 'application/json',
      },
      accepted: paymentRequirements,
    };

    // 5. Verify & Settle via BatchFacilitatorClient (Circle Gateway x402 batch facilitator)
    // Arc Testnet (eip155:5042002) is supported on the Circle TESTNET facilitator endpoint.
    // The production endpoint (gateway-api.circle.com) does not whitelist Arc Testnet yet.
    const facilitator = new BatchFacilitatorClient({
      url: 'https://gateway-api-testnet.circle.com',
    });

    const verifyRes = await facilitator.verify(fullPayload as any, paymentRequirements);
    console.log('[TaskFee] verify response:', JSON.stringify(verifyRes));
    if (!verifyRes.isValid) {
      console.warn(`[TaskFee] Gateway verify warning: ${verifyRes.invalidReason ?? 'unknown reason'}`);
    }

    const settleRes = await facilitator.settle(fullPayload as any, paymentRequirements);
    console.log('[TaskFee] settle response:', JSON.stringify(settleRes));
    if (!settleRes.success) {
      throw new Error(`Circle Gateway settlement failed: ${settleRes.errorReason ?? 'Unknown settlement error'}`);
    }

    receipt.settled = true;
    receipt.txHash = settleRes.transaction || receipt.nonce;
    console.log(`[TaskFee] ✓ Circle Gateway nanopayment task fee settled ($${feeDisplay} USDC) via x402 Facilitator — Tx: ${receipt.txHash}`);

    return receipt;
  } catch (err: any) {
    receipt.error = `Nanopayments task fee transfer warning: ${err.message || String(err)}`;
    console.warn(`[TaskFee] ${receipt.error} — daemon loop continues.`);
    return receipt;
  }
}

/** Splits a 65-byte hex signature into v/r/s components */
function splitSignature(sig: `0x${string}`): { v: number; r: `0x${string}`; s: `0x${string}` } {
  const raw = sig.slice(2); // strip 0x
  const r = `0x${raw.slice(0, 64)}` as `0x${string}`;
  const s = `0x${raw.slice(64, 128)}` as `0x${string}`;
  const v = parseInt(raw.slice(128, 130), 16);
  return { v, r, s };
}
