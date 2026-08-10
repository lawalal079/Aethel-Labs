import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, http, formatUnits, getAddress, parseAbi } from 'viem';

const ARC_TESTNET_RPC = process.env.NEXT_PUBLIC_ARC_RPC_URL || 'https://rpc.testnet.arc.network';
const GATEWAY_ADDRESS  = (process.env.GATEWAY_ADDRESS || '0x0077777d7EBA4688BDeF3E311b846F25870A19B9') as `0x${string}`;
const USDC_ADDRESS     = (process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000') as `0x${string}`;

const GATEWAY_ABI = parseAbi([
  'function availableBalance(address token, address depositor) external view returns (uint256)',
]);

const publicClient = createPublicClient({
  transport: http(ARC_TESTNET_RPC),
});

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const addressParam = searchParams.get('address');

    if (!addressParam) {
      return NextResponse.json({ success: false, error: 'Missing address parameter' }, { status: 400 });
    }

    const depositor = getAddress(addressParam);

    // 1. Fetch on-chain Gateway availableBalance from GatewayWallet contract
    let onChainBalance = '0.000000';
    try {
      const raw = await publicClient.readContract({
        address: GATEWAY_ADDRESS,
        abi: GATEWAY_ABI,
        functionName: 'availableBalance',
        args: [USDC_ADDRESS, depositor],
      });
      onChainBalance = parseFloat(formatUnits(raw as bigint, 6)).toFixed(6);
    } catch (err: any) {
      console.warn('[gateway-balance] On-chain RPC query error:', err.message);
    }

    // 2. Query Circle Gateway REST API /v1/balances endpoint
    let circleApiBalance: string | null = null;
    let circleApiData: any = null;
    try {
      const circleRes = await fetch('https://gateway-api-testnet.circle.com/v1/balances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'USDC',
          sources: [
            {
              depositor,
              domain: 26, // Arc Testnet domain ID
            },
          ],
        }),
      });
      if (circleRes.ok) {
        circleApiData = await circleRes.json();
        const found = circleApiData?.balances?.[0]?.balance;
        if (found !== undefined && found !== null) {
          circleApiBalance = parseFloat(found).toFixed(6);
        }
      }
    } catch (err: any) {
      console.warn('[gateway-balance] Circle API query error:', err.message);
    }

    const netBalance = onChainBalance !== '0.000000' ? onChainBalance : (circleApiBalance !== null ? circleApiBalance : '0.000000');

    return NextResponse.json({
      success: true,
      depositorAddress: depositor,
      balance: netBalance,
      onChainBalance,
      circleApiBalance,
      circleApiData,
      timestamp: Date.now(),
    });
  } catch (err: any) {
    console.error('[gateway-balance] Error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
