import { createPublicClient, http, parseAbi, parseUnits, formatUnits, type Address } from 'viem';
import { getCircleClient } from './trading-wallet';
import { randomUUID } from 'crypto';

export const ARC_RPC_URL = process.env.RPC_URL || 'https://rpc.testnet.arc.network';
export const ARC_CHAIN_ID = 5042002;

export const ARC_DEX_ROUTER_ADDRESS = '0xAF076A2DaA8fA1B30e51CEE5C9eed989f9f3BD58' as Address;
export const ARC_USDC_BTC_POOL_ADDRESS = '0x05eff4c5152178641b3e4a0bf07d797d2ad9a68f' as Address;

export const TOKEN_ADDRESSES: Record<string, { address: Address; decimals: number }> = {
  USDC: { address: '0x3600000000000000000000000000000000000000' as Address, decimals: 6 },
  EURC: { address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a' as Address, decimals: 6 },
  cirBTC: { address: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF' as Address, decimals: 8 },
};

const publicClient = createPublicClient({
  transport: http(ARC_RPC_URL),
});

const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
]);

const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

/**
 * Uniswap V2 constant-product formula (0.3% fee)
 */
function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * 997n;
  const numerator = amountInWithFee * reserveOut;
  const denominator = (reserveIn * 1000n) + amountInWithFee;
  return numerator / denominator;
}

/**
 * Calculates estimated swap output on Arc Testnet for DEX Router using live pool reserves
 */
export async function getLiveDexQuote(tokenIn: string, tokenOut: string, amountInStr: string): Promise<{ amountOut: string; effectiveRate: string }> {
  const tokenInInfo = TOKEN_ADDRESSES[tokenIn];
  const tokenOutInfo = TOKEN_ADDRESSES[tokenOut];

  if (!tokenInInfo || !tokenOutInfo) {
    throw new Error(`Unsupported token pair for DEX Router: ${tokenIn} -> ${tokenOut}`);
  }

  const amountInUnits = parseUnits(amountInStr, tokenInInfo.decimals);

  try {
    const [reserves, token0] = await Promise.all([
      publicClient.readContract({ address: ARC_USDC_BTC_POOL_ADDRESS, abi: PAIR_ABI, functionName: 'getReserves' }),
      publicClient.readContract({ address: ARC_USDC_BTC_POOL_ADDRESS, abi: PAIR_ABI, functionName: 'token0' }),
    ]);

    const isToken0In = token0.toLowerCase() === tokenInInfo.address.toLowerCase();
    const reserveIn = BigInt(isToken0In ? reserves[0] : reserves[1]);
    const reserveOut = BigInt(isToken0In ? reserves[1] : reserves[0]);

    const outUnits = getAmountOut(amountInUnits, reserveIn, reserveOut);
    const amountOut = formatUnits(outUnits, tokenOutInfo.decimals);
    const inNum = parseFloat(amountInStr) || 1;
    const outNum = parseFloat(amountOut) || 0;
    const effectiveRate = inNum > 0 ? (outNum / inNum).toString() : '0';

    return { amountOut, effectiveRate };
  } catch (err) {
    console.warn(`[DexRouter] Error fetching live pool reserves, falling back to static quote:`, err);
    // Static fallback
    const BTC_PRICE = 63800.0;
    const inNum = parseFloat(amountInStr) || 0;
    const rate = tokenIn === 'USDC' ? (1 / BTC_PRICE) : BTC_PRICE;
    const amountOut = (inNum * rate).toFixed(tokenOutInfo.decimals);
    return { amountOut, effectiveRate: rate.toString() };
  }
}

/**
 * Executes a direct on-chain swap via Arc Testnet DEX Router (0xAF076A2DaA8fA1B30e51CEE5C9eed989f9f3BD58)
 * using Circle Developer-Controlled Wallets createContractExecutionTransaction
 */
export async function executeDexRouterSwap(params: {
  walletId: string;
  walletAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippageBps?: number;
}): Promise<{ amountOut: string; txHash?: string }> {
  const tokenInInfo = TOKEN_ADDRESSES[params.tokenIn];
  const tokenOutInfo = TOKEN_ADDRESSES[params.tokenOut];

  if (!tokenInInfo || !tokenOutInfo) {
    throw new Error(`Unsupported token pair for DEX Router: ${params.tokenIn} -> ${params.tokenOut}`);
  }

  const amountInUnits = parseUnits(params.amountIn, tokenInInfo.decimals);
  const quote = await getLiveDexQuote(params.tokenIn, params.tokenOut, params.amountIn);
  const expectedOutUnits = parseUnits(quote.amountOut, tokenOutInfo.decimals);
  
  // Calculate minimum return with slippage tolerance (default 2% or 200 bps for testnet AMM)
  const slippageBps = BigInt(params.slippageBps || 200);
  const minOutUnits = (expectedOutUnits * (10000n - slippageBps)) / 10000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800); // 30 minutes

  const client = getCircleClient();
  const routerAddress = ARC_DEX_ROUTER_ADDRESS;

  console.log(
    `[DexRouter] Submitting swap on Tower DEX Router ${routerAddress}: ` +
    `${params.amountIn} ${params.tokenIn} -> expected ${quote.amountOut} ${params.tokenOut} (min ${formatUnits(minOutUnits, tokenOutInfo.decimals)})`
  );

  // 1. Check ERC-20 allowance on-chain
  try {
    const currentAllowance = await publicClient.readContract({
      address: tokenInInfo.address,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [params.walletAddress as Address, routerAddress],
    });

    if (currentAllowance < amountInUnits) {
      console.log(`[DexRouter] Submitting ERC20 approve transaction for router ${routerAddress}...`);
      const maxApprove = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
      
      const approveRes: any = await client.createContractExecutionTransaction({
        idempotencyKey: randomUUID(),
        walletId: params.walletId,
        contractAddress: tokenInInfo.address,
        abiFunctionSignature: 'approve(address,uint256)',
        abiParameters: [routerAddress, maxApprove],
        fee: {
          type: 'level',
          config: {
            feeLevel: 'MEDIUM',
          },
        },
      });
      const approveId = approveRes.data?.id;
      console.log(`[DexRouter] Approval submitted: ID=${approveId}. Waiting 4s for confirmation...`);
      await new Promise(r => setTimeout(r, 4000));
    }
  } catch (err) {
    console.warn(`[DexRouter] Allowance check warning:`, err);
  }

  // 2. Execute swap on router contract: swap(address,address,uint256,uint256,address,uint256)
  const swapRes: any = await client.createContractExecutionTransaction({
    idempotencyKey: randomUUID(),
    walletId: params.walletId,
    contractAddress: routerAddress,
    abiFunctionSignature: 'swap(address,address,uint256,uint256,address,uint256)',
    abiParameters: [
      tokenInInfo.address,
      tokenOutInfo.address,
      amountInUnits.toString(),
      minOutUnits.toString(),
      params.walletAddress,
      deadline.toString(),
    ],
    fee: {
      type: 'level',
      config: {
        feeLevel: 'MEDIUM',
      },
    },
  });

  const txId = swapRes.data?.id;
  let finalTxHash = swapRes.data?.txHash;

  console.log(`[DexRouter] Swap submitted: Circle ID=${txId}. Awaiting on-chain confirmation...`);

  // 3. Poll transaction status for up to 20 seconds to confirm on-chain execution and get real txHash
  if (txId) {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const txStatus = await client.getTransaction({ id: txId });
        const txData = txStatus.data?.transaction;
        if (txData?.txHash) {
          finalTxHash = txData.txHash;
        }
        if (txData?.state === 'CONFIRMED' || txData?.state === 'COMPLETE') {
          console.log(`[DexRouter] ✓ On-chain swap CONFIRMED: TxHash=${finalTxHash}`);
          break;
        }
        if (txData?.state === 'FAILED') {
          console.error(`[DexRouter] ✗ On-chain swap failed: ${txData.errorDetails || txData.errorReason}`);
          throw new Error(`DEX swap execution failed on-chain: ${txData.errorDetails || txData.errorReason}`);
        }
      } catch (pollErr: any) {
        if (pollErr.message?.includes('DEX swap execution failed')) throw pollErr;
      }
    }
  }

  return {
    amountOut: quote.amountOut,
    txHash: finalTxHash || txId,
  };
}
