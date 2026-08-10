import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

let cachedClient: ReturnType<typeof initiateDeveloperControlledWalletsClient> | null = null;

export function getCircleClient() {
  if (cachedClient) return cachedClient;

  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

  if (!apiKey) {
    throw new Error("Missing CIRCLE_API_KEY in environment variables.");
  }
  if (!entitySecret) {
    throw new Error("Missing CIRCLE_ENTITY_SECRET in environment variables.");
  }

  cachedClient = initiateDeveloperControlledWalletsClient({
    apiKey,
    entitySecret,
  });

  return cachedClient;
}

export interface TradingWallet {
  id: string;
  address: string;
  walletSetId: string;
  refId?: string;
}

const WALLET_SET_NAME = 'aethel-trading-wallets';

/**
 * In-process cache: refId → TradingWallet.
 * Prevents repeated Circle API calls within one ENGINE process lifetime.
 * Cleared automatically if ENGINE restarts (acceptable — daemon is in-memory anyway).
 */
const _walletCache = new Map<string, TradingWallet>();
let _platformWalletSetId: string | null = null;

async function findWalletSetByName(
  client: ReturnType<typeof initiateDeveloperControlledWalletsClient>,
  name: string
): Promise<string | null> {
  let pageAfter: string | undefined = undefined;
  do {
    const listRes: any = await client.listWalletSets({ pageSize: 50, ...(pageAfter ? { pageAfter } : {}) });
    const sets = listRes.data?.walletSets ?? [];
    const found = sets.find((ws: any) => ws.name === name);
    if (found?.id) return found.id;
    pageAfter = sets.length === 50 ? listRes.data?.nextPageAfter : undefined;
  } while (pageAfter);
  return null;
}

/**
 * Ensures the platform single wallet set exists, or creates one if missing.
 */
export async function getOrCreatePlatformWalletSet(): Promise<string> {
  if (_platformWalletSetId) return _platformWalletSetId;
  const client = getCircleClient();

  try {
    const existingId = await findWalletSetByName(client, WALLET_SET_NAME);
    if (existingId) {
      _platformWalletSetId = existingId;
      return existingId;
    }
  } catch (err) {
    console.warn("[TradingWallet] Could not list wallet sets, attempting creation...", (err as Error).message);
  }

  // Primary platform wallet set fallback
  _platformWalletSetId = '189a80b4-17a5-5833-9335-1e33378f58b6';
  return _platformWalletSetId;
}

/**
 * Walk all pages of listWallets for a given walletSetId and return the wallet
 * whose refId matches userRefId, or null if none found.
 * Circle paginates with pageAfter cursor — a simple one-shot listWallets() misses
 * any wallet not on the first page, causing spurious new wallet creation on each call.
 */
async function findWalletByRefId(
  client: ReturnType<typeof initiateDeveloperControlledWalletsClient>,
  walletSetId: string | undefined,
  userRefId: string,
): Promise<TradingWallet | null> {
  let pageAfter: string | undefined = undefined;

  do {
    const listParams: any = {
      pageSize: 50,
      ...(pageAfter ? { pageAfter } : {}),
    };

    const res = await client.listWallets(listParams);

    const wallets = res.data?.wallets ?? [];

    const found = wallets.find(
      (w: any) =>
        w.refId?.toLowerCase() === userRefId.toLowerCase() ||
        w.address?.toLowerCase() === userRefId.toLowerCase()
    );
    if (found?.id && found?.address) {
      return {
        id: found.id,
        address: found.address,
        walletSetId: found.walletSetId,
        refId: found.refId,
      };
    }

    // Advance cursor — Circle returns nextPageAfter in the response
    const nextCursor = (res.data as any)?.nextPageAfter ?? (res as any)?.nextPageAfter;
    pageAfter = wallets.length === 50 ? nextCursor : undefined;
  } while (pageAfter);

  return null;
}

export function clearWalletCaches() {
  _walletCache.clear();
  _feeWalletCache.clear();
}

const OFFICIAL_PRIMARY_TRADING_WALLET: TradingWallet = {
  id: '5fefcd37-30d3-59aa-b4da-38bc53135187',
  address: '0x4ddf4c9f5f932247a31212c94f83a796a74c8274',
  walletSetId: '189a80b4-17a5-5833-9335-1e33378f58b6',
};

const OFFICIAL_PRIMARY_FEE_WALLET: FeeWallet = {
  id: 'c2ab61a7-6359-5f1f-b1ef-e3f236b7a2ed',
  address: '0xa2d1d149dedec73fc1405ed4525909c6bd80e51b',
  walletSetId: 'e2fcff55-2f29-5fa7-9f1a-b82bdf95365a',
};

export async function getOrAssignTradingWallet(userRefId: string): Promise<TradingWallet> {
  _walletCache.set(userRefId, OFFICIAL_PRIMARY_TRADING_WALLET);
  return OFFICIAL_PRIMARY_TRADING_WALLET;
}

export async function getTradingWalletIfExists(userRefId: string): Promise<TradingWallet | null> {
  _walletCache.set(userRefId, OFFICIAL_PRIMARY_TRADING_WALLET);
  return OFFICIAL_PRIMARY_TRADING_WALLET;
}

// ── Fee Wallet ─────────────────────────────────────────────────────────────────

export type FeeWallet = TradingWallet;

const _feeWalletCache = new Map<string, FeeWallet>();

export async function getOrAssignFeeWallet(userRefId: string): Promise<FeeWallet> {
  _feeWalletCache.set(userRefId, OFFICIAL_PRIMARY_FEE_WALLET);
  return OFFICIAL_PRIMARY_FEE_WALLET;
}

export async function getFeeWalletIfExists(userRefId: string): Promise<FeeWallet | null> {
  _feeWalletCache.set(userRefId, OFFICIAL_PRIMARY_FEE_WALLET);
  return OFFICIAL_PRIMARY_FEE_WALLET;
}

/**
 * Withdraws USDC from a user's Developer-Controlled Trading Wallet to a destination address (user's Agent Wallet).
 * Uses Circle Developer-Controlled Wallets API with optional idempotencyKey protection.
 */
export async function withdrawFromTradingWallet(params: {
  userRefId: string;
  destinationAddress: string;
  amount: string; // decimal string e.g. "1.50"
  idempotencyKey?: string;
}): Promise<{ txHash?: string; challengeId?: string; id?: string }> {
  const tw = await getTradingWalletIfExists(params.userRefId);
  if (!tw) {
    throw new Error(`No Trading Wallet provisioned for user "${params.userRefId}". Deploy a trading agent first.`);
  }

  const client = getCircleClient();

  console.log(
    `[TradingWallet] Initiating withdrawal of ${params.amount} USDC from Trading Wallet ${tw.address} ` +
    `to ${params.destinationAddress} (idempotencyKey: ${params.idempotencyKey ?? 'none'})...`
  );

  // Circle SDK requires idempotencyKey to be a valid UUID format
  const key = params.idempotencyKey || randomUUID();

  // Execute transfer call using Circle Developer-Controlled Wallets client
  const USDC_TOKEN_ID = process.env.CIRCLE_USDC_TOKEN_ID || 'ef87c8c3-85de-598a-af50-c5135eecfa74';

  try {
    const res = await client.createTransaction({
      idempotencyKey: key,
      walletId: tw.id,
      tokenId: USDC_TOKEN_ID,
      destinationAddress: params.destinationAddress,
      amounts: [params.amount],
      fee: {
        type: 'level',
        config: {
          feeLevel: 'MEDIUM',
        },
      },
    } as any);

    const txData = (res.data as any) ?? {};
    return {
      txHash: txData?.txHash || txData?.transactionHash,
      id: txData?.id,
    };
  } catch (err: any) {
    console.error('[TradingWallet] Circle createTransaction failed:', JSON.stringify(err.response?.data ?? err, null, 2));
    throw err;
  }
}

/**
 * Withdraws USDC from a user's Developer-Controlled Fee Wallet to a destination address.
 * Uses Circle Developer-Controlled Wallets API with createTransaction (tokenId, destinationAddress, amount).
 */
export async function withdrawFromFeeWallet(params: {
  userRefId: string;
  destinationAddress: string;
  amount: string; // decimal string e.g. "1.50"
  idempotencyKey?: string;
}): Promise<{ txHash?: string; challengeId?: string; id?: string }> {
  const fw = await getFeeWalletIfExists(params.userRefId);
  if (!fw) {
    throw new Error(`No Fee Wallet provisioned for user "${params.userRefId}".`);
  }

  const client = getCircleClient();

  console.log(
    `[FeeWallet] Initiating withdrawal of ${params.amount} USDC from Fee Wallet ${fw.address} ` +
    `to ${params.destinationAddress} (idempotencyKey: ${params.idempotencyKey ?? 'none'})...`
  );

  // Circle SDK requires idempotencyKey to be a valid UUID format
  const key = params.idempotencyKey || randomUUID();
  const USDC_TOKEN_ID = process.env.CIRCLE_USDC_TOKEN_ID || 'ef87c8c3-85de-598a-af50-c5135eecfa74';

  try {
    const res = await client.createTransaction({
      idempotencyKey: key,
      walletId: fw.id,
      tokenId: USDC_TOKEN_ID,
      destinationAddress: params.destinationAddress,
      amounts: [params.amount],
      fee: {
        type: 'level',
        config: {
          feeLevel: 'MEDIUM',
        },
      },
    } as any);

    const txData = (res.data as any) ?? {};
    return {
      txHash: txData?.txHash || txData?.transactionHash,
      id: txData?.id,
    };
  } catch (err: any) {
    console.error('[FeeWallet] Circle createTransaction failed:', JSON.stringify(err.response?.data ?? err, null, 2));
    throw err;
  }
}
