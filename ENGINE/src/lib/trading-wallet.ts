import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

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

const _walletCache = new Map<string, TradingWallet>();
const _feeWalletCache = new Map<string, FeeWallet>();
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
    console.warn("[TradingWallet] Could not list wallet sets, attempting fallback...", (err as Error).message);
  }

  _platformWalletSetId = '189a80b4-17a5-5833-9335-1e33378f58b6';
  return _platformWalletSetId;
}

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

    const nextCursor = (res.data as any)?.nextPageAfter ?? (res as any)?.nextPageAfter;
    pageAfter = wallets.length === 50 ? nextCursor : undefined;
  } while (pageAfter);

  return null;
}

export function clearWalletCaches() {
  _walletCache.clear();
  _feeWalletCache.clear();
}

/**
 * Utility to format string into valid RFC-4122 UUID format required by Circle API
 */
function toUUID(str: string): string {
  const hex = keccak256(toBytes(str)).replace('0x', '').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Derives a unique, deterministic wallet per userRefId as fallback
 */
function deriveUserWallet(userRefId: string, isFeeWallet = false): TradingWallet {
  const normRef = userRefId.toLowerCase().trim();
  const salt = isFeeWallet ? '_aethel_fee_wallet_v2' : '_aethel_trading_wallet_v2';
  const hash = keccak256(toBytes(normRef + salt));
  const account = privateKeyToAccount(hash as `0x${string}`);

  return {
    id: toUUID(normRef + salt),
    address: account.address.toLowerCase(),
    walletSetId: isFeeWallet ? 'e2fcff55-2f29-5fa7-9f1a-b82bdf95365a' : '189a80b4-17a5-5833-9335-1e33378f58b6',
    refId: normRef,
  };
}

export async function getOrAssignTradingWallet(userRefId: string): Promise<TradingWallet> {
  const normRef = (userRefId || 'anonymous_user').toLowerCase().trim();

  if (_walletCache.has(normRef)) {
    return _walletCache.get(normRef)!;
  }

  try {
    const client = getCircleClient();
    const walletSetId = await getOrCreatePlatformWalletSet();
    const existing = await findWalletByRefId(client, walletSetId, normRef);
    if (existing) {
      _walletCache.set(normRef, existing);
      return existing;
    }

    const createRes: any = await client.createWallets({
      walletSetId,
      count: 1,
      blockchains: ['ARC-TESTNET' as any],
      refId: normRef,
    } as any);
    const newW = createRes.data?.wallets?.[0];
    if (newW?.id && newW?.address) {
      const walletObj: TradingWallet = {
        id: newW.id,
        address: newW.address,
        walletSetId: newW.walletSetId || walletSetId,
        refId: normRef,
      };
      _walletCache.set(normRef, walletObj);
      return walletObj;
    }
  } catch (err: any) {
    console.warn(`[TradingWallet] Circle API lookup/creation failed for user ${normRef}:`, err?.message ?? err);
  }

  const fallbackWallet = deriveUserWallet(normRef, false);
  _walletCache.set(normRef, fallbackWallet);
  return fallbackWallet;
}

export async function getTradingWalletIfExists(userRefId: string): Promise<TradingWallet | null> {
  const normRef = (userRefId || 'anonymous_user').toLowerCase().trim();

  if (_walletCache.has(normRef)) {
    return _walletCache.get(normRef)!;
  }

  try {
    const client = getCircleClient();
    const walletSetId = await getOrCreatePlatformWalletSet();
    const existing = await findWalletByRefId(client, walletSetId, normRef);
    if (existing) {
      _walletCache.set(normRef, existing);
      return existing;
    }
  } catch (err: any) {
    console.warn(`[TradingWallet] Circle API lookup failed for user ${normRef}:`, err?.message ?? err);
  }

  const fallbackWallet = deriveUserWallet(normRef, false);
  _walletCache.set(normRef, fallbackWallet);
  return fallbackWallet;
}

// ── Fee Wallet ─────────────────────────────────────────────────────────────────

export type FeeWallet = TradingWallet;

export async function getOrAssignFeeWallet(userRefId: string): Promise<FeeWallet> {
  const normRef = (userRefId || 'anonymous_user').toLowerCase().trim();

  if (_feeWalletCache.has(normRef)) {
    return _feeWalletCache.get(normRef)!;
  }

  try {
    const client = getCircleClient();
    const walletSetId = await getOrCreatePlatformWalletSet();
    const existing = await findWalletByRefId(client, walletSetId, `fee_${normRef}`);
    if (existing) {
      _feeWalletCache.set(normRef, existing);
      return existing;
    }
  } catch (err: any) {
    console.warn(`[FeeWallet] Circle API lookup failed for fee user ${normRef}:`, err?.message ?? err);
  }

  const fallbackWallet = deriveUserWallet(normRef, true);
  _feeWalletCache.set(normRef, fallbackWallet);
  return fallbackWallet;
}

export async function getFeeWalletIfExists(userRefId: string): Promise<FeeWallet | null> {
  const normRef = (userRefId || 'anonymous_user').toLowerCase().trim();

  if (_feeWalletCache.has(normRef)) {
    return _feeWalletCache.get(normRef)!;
  }

  try {
    const client = getCircleClient();
    const walletSetId = await getOrCreatePlatformWalletSet();
    const existing = await findWalletByRefId(client, walletSetId, `fee_${normRef}`);
    if (existing) {
      _feeWalletCache.set(normRef, existing);
      return existing;
    }
  } catch (err: any) {
    console.warn(`[FeeWallet] Circle API lookup failed for fee user ${normRef}:`, err?.message ?? err);
  }

  const fallbackWallet = deriveUserWallet(normRef, true);
  _feeWalletCache.set(normRef, fallbackWallet);
  return fallbackWallet;
}

/**
 * Withdraws USDC from a user's Developer-Controlled Trading Wallet to a destination address.
 */
export async function withdrawFromTradingWallet(params: {
  userRefId: string;
  destinationAddress: string;
  amount: string;
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

  const key = params.idempotencyKey || randomUUID();
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
 */
export async function withdrawFromFeeWallet(params: {
  userRefId: string;
  destinationAddress: string;
  amount: string;
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
