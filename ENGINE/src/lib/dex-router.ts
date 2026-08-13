import { createPublicClient, http, parseAbi, parseUnits, formatUnits, type Address } from 'viem';
import { getCircleClient } from './trading-wallet';
import { randomUUID } from 'crypto';

export const ARC_RPC_URL = process.env.RPC_URL || 'https://rpc.testnet.arc.network';
export const ARC_CHAIN_ID = 5042002;

export const ARC_DEX_ROUTER_ADDRESS = '0xAF076A2DaA8fA1B30e51CEE5C9eed989f9f3BD58' as Address;

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

/**
 * Calculates estimated swap output on Arc Testnet for DEX Router
 */
export function estimateDexRouterOutput(tokenIn: string, tokenOut: string, amountInStr: string): { amountOut: string; effectiveRate: string } {
  const inNum = parseFloat(amountInStr) || 0;
  let rate = 1.0;

  const BTC_PRICE_USD = 63800.0;
  const EUR_PRICE_USD = 1.08;

  if (tokenIn === 'USDC' && tokenOut === 'cirBTC') {
    rate = 1 / BTC_PRICE_USD;
  } else if (tokenIn === 'cirBTC' && tokenOut === 'USDC') {
    rate = BTC_PRICE_USD;
  } else if (tokenIn === 'USDC' && tokenOut === 'EURC') {
    rate = 1 / EUR_PRICE_USD;
  } else if (tokenIn === 'EURC' && tokenOut === 'USDC') {
    rate = EUR_PRICE_USD;
  } else if (tokenIn === 'EURC' && tokenOut === 'cirBTC') {
    rate = EUR_PRICE_USD / BTC_PRICE_USD;
  } else if (tokenIn === 'cirBTC' && tokenOut === 'EURC') {
    rate = BTC_PRICE_USD / EUR_PRICE_USD;
  }

  const outNum = inNum * rate;
  const decimals = tokenOut === 'cirBTC' ? 8 : 6;
  const amountOut = outNum.toFixed(decimals);
  const effectiveRate = rate.toString();

  return { amountOut, effectiveRate };
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
}): Promise<{ amountOut: string; txHash?: string; challengeId?: string }> {
  const tokenInInfo = TOKEN_ADDRESSES[params.tokenIn];
  const tokenOutInfo = TOKEN_ADDRESSES[params.tokenOut];

  if (!tokenInInfo || !tokenOutInfo) {
    throw new Error(`Unsupported token pair for DEX Router: ${params.tokenIn} -> ${params.tokenOut}`);
  }

  const amountInUnits = parseUnits(params.amountIn, tokenInInfo.decimals);
  const estimate = estimateDexRouterOutput(params.tokenIn, params.tokenOut, params.amountIn);
  const expectedOutUnits = parseUnits(estimate.amountOut, tokenOutInfo.decimals);
  
  // Calculate minimum return with slippage tolerance (default 0.5% or 50 bps)
  const slippageBps = BigInt(params.slippageBps || 50);
  const minOutUnits = (expectedOutUnits * (10000n - slippageBps)) / 10000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800); // 30 minutes

  const client = getCircleClient();
  const routerAddress = ARC_DEX_ROUTER_ADDRESS;

  console.log(`[DexRouter] Executing on-chain swap: ${params.amountIn} ${params.tokenIn} -> min ${formatUnits(minOutUnits, tokenOutInfo.decimals)} ${params.tokenOut} on router ${routerAddress}`);

  // 1. Check ERC-20 allowance on-chain
  try {
    const currentAllowance = await publicClient.readContract({
      address: tokenInInfo.address,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [params.walletAddress as Address, routerAddress],
    });

    if (currentAllowance < amountInUnits) {
      console.log(`[DexRouter] Insufficient allowance (${currentAllowance} < ${amountInUnits}). Submitting approval...`);
      const maxApprove = '115792089237316195423570985008687907853269984665640564039457584007913129639935'; // type(uint256).max
      
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
      console.log(`[DexRouter] Approval transaction submitted: ID=${approveRes.data?.id ?? 'done'}`);
      
      // Allow brief confirmation window
      await new Promise(r => setTimeout(r, 3000));
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
  const txHash = swapRes.data?.txHash;
  console.log(`[DexRouter] ✓ DEX swap transaction submitted: ID=${txId} Hash=${txHash ?? 'processing'}`);

  return {
    amountOut: estimate.amountOut,
    txHash: txHash || txId,
  };
}
