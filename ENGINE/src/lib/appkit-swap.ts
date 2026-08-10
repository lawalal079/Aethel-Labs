import { AppKit, SwapChain } from '@circle-fin/app-kit';
import { createCircleWalletsAdapter } from '@circle-fin/adapter-circle-wallets';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

let cachedKit: AppKit | null = null;
let cachedAdapter: ReturnType<typeof createCircleWalletsAdapter> | null = null;

function kit() {
  if (!cachedKit) cachedKit = new AppKit();
  return cachedKit;
}

function adapter() {
  if (cachedAdapter) return cachedAdapter;
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

  if (!apiKey || !entitySecret) {
    throw new Error("Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET in environment variables.");
  }

  cachedAdapter = createCircleWalletsAdapter({
    apiKey,
    entitySecret,
  });
  return cachedAdapter;
}

function getChain(): SwapChain {
  const chainName = (process.env.NEXT_PUBLIC_ARC_CHAIN || 'Arc_Testnet') as keyof typeof SwapChain;
  const resolved = SwapChain[chainName];
  if (!resolved) {
    throw new Error(`Invalid ARC_CHAIN identifier ("${chainName}") for SwapChain.`);
  }
  return resolved;
}

export type QuoteInput = {
  walletAddress: string;
  tokenIn: 'USDC' | 'EURC' | 'cirBTC';
  tokenOut: 'USDC' | 'EURC' | 'cirBTC';
  amountIn: string;
};

export type QuoteResult = {
  amountOut: string;
  appFeeBps: number;
  effectiveRate: string;
};

function getKitKey(): string {
  const envKitKey = process.env.KIT_KEY;
  if (envKitKey && envKitKey.startsWith('KIT_KEY:')) {
    return envKitKey;
  }
  const apiKey = process.env.CIRCLE_API_KEY || '';
  if (apiKey.includes(':')) {
    const parts = apiKey.split(':');
    if (parts.length >= 3) {
      return `KIT_KEY:${parts[1]}:${parts[2]}`;
    }
  }
  return envKitKey || '';
}

export async function estimateSwap({
  walletAddress,
  tokenIn,
  tokenOut,
  amountIn,
}: QuoteInput): Promise<QuoteResult> {
  const kitKey = getKitKey();
  const appFeeBps = Number(process.env.APP_FEE_BPS || 25);

  let result;
  try {
    result = await kit().estimateSwap({
      from: { adapter: adapter(), chain: getChain(), address: walletAddress },
      tokenIn,
      tokenOut,
      amountIn,
      config: { kitKey },
    });
  } catch (err: any) {
    const fullMsg = err instanceof Error ? err.message : String(err);
    const causeMsg = err?.cause ? (err.cause.message || String(err.cause)) : '';
    const details = err?.details || err?.response?.data || '';

    console.error(`[AppKitSwap] kit().estimateSwap() failed for wallet ${walletAddress}:`);
    console.error(`  - Message: ${fullMsg}`);
    if (causeMsg) console.error(`  - Cause: ${causeMsg}`);
    if (details) console.error(`  - Details: ${JSON.stringify(details)}`);
    console.error(`  - Full Error Object:`, JSON.stringify(err, Object.getOwnPropertyNames(err), 2));

    throw new Error(`Estimate swap failed for ${amountIn} ${tokenIn} -> ${tokenOut} on wallet ${walletAddress}: ${fullMsg}${causeMsg ? ` (Cause: ${causeMsg})` : ''}`);
  }

  const amountOut = result.estimatedOutput.amount;
  const inNum = Number(amountIn);
  const outNum = Number(amountOut);
  const effectiveRate = inNum > 0 ? (outNum / inNum).toString() : '0';

  return { amountOut, appFeeBps, effectiveRate };
}

export type ExecuteInput = QuoteInput & {
  slippageBps?: number;
  stopLimit?: string;
};

export type ExecuteResult = {
  amountOut?: string;
  txHash?: string;
};

export async function executeSwap({
  walletAddress,
  tokenIn,
  tokenOut,
  amountIn,
  slippageBps = 50,
  stopLimit,
}: ExecuteInput): Promise<ExecuteResult> {
  const kitKey = getKitKey();
  const appFeeBps = Number(process.env.APP_FEE_BPS || 25);
  const recipientAddress = process.env.APP_FEE_RECIPIENT || '0xDe45Ec28834C609307BEf5651688A6c41d5e6994';

  const baseConfig = {
    kitKey,
    slippageBps,
    ...(stopLimit ? { stopLimit } : {}),
    customFee: {
      percentageBps: appFeeBps,
      recipientAddress,
    },
  };

  const params = {
    from: { adapter: adapter(), chain: getChain(), address: walletAddress },
    tokenIn,
    tokenOut,
    amountIn,
  };

  let result;
  try {
    result = await kit().swap({ ...params, config: baseConfig });
  } catch (err) {
    if (isUndeployedWalletError(err)) {
      console.log(`[AppKitSwap] Wallet ${walletAddress} is undeployed. Retrying swap with allowanceStrategy: "approve"...`);
      result = await kit().swap({
        ...params,
        config: { ...baseConfig, allowanceStrategy: 'approve' },
      });
    } else {
      console.error("[AppKitSwap] Live kit().swap() failed:", String(err));
      throw err;
    }
  }

  return {
    amountOut: result.amountOut,
    txHash: result.txHash,
  };
}

function isUndeployedWalletError(err: unknown): boolean {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : String(err);
  return /undeployed wallet/i.test(message);
}
