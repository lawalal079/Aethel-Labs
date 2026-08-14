/**
 * /api/agents/deploy — Next.js App Router API route
 *
 * Frontend proxy for the ENGINE's POST /agents/deploy endpoint.
 *
 * Responsibility split:
 *   1. This route: on-chain license check (defense-in-depth, first layer)
 *   2. ENGINE /agents/deploy: Circle token auth + second on-chain license check (real enforcement)
 *
 * IMPORTANT — Authorization header forwarding:
 *   The caller's original "Authorization: Bearer <circle-token>" header is forwarded
 *   to the ENGINE unchanged. The ENGINE derives the user's wallet address from that
 *   token via Circle's API — it never trusts a header we set here. Do not strip or
 *   replace the Authorization header in this proxy.
 *
 * Supported actions: deploy (POST), status (GET)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, http, parseAbi, type Address } from 'viem';

// ── Chain & contract config (mirrors endpoints/route.ts) ─────────────────────

const _CHAIN_ID   = parseInt(process.env.NEXT_PUBLIC_CHAIN_ID ?? '5042002', 10);
const _RPC_URL    = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://rpc.testnet.arc.network';
const _PROXY_ADDR = (process.env.NEXT_PUBLIC_MARKETPLACE_ADDRESS ?? '') as Address;

const _arcChain = {
  id: _CHAIN_ID,
  name: process.env.NEXT_PUBLIC_CHAIN_NAME ?? 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: { default: { http: [_RPC_URL] }, public: { http: [_RPC_URL] } },
} as const;

const _publicClient = createPublicClient({
  chain: _arcChain as any,
  transport: http(_RPC_URL),
});

const _LICENSE_ABI = parseAbi([
  'function userLicenses(address, string) view returns (bool)',
]);

const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL ?? 'http://localhost:4000';

// ── POST /api/agents/deploy ───────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userAddress, feeWalletAddress, agentId, intervalSeconds } = body ?? {};
    console.log(`\n[fe-deploy-1] Received /api/agents/deploy for user=${userAddress}, feeWallet=${feeWalletAddress ?? 'not-provided'}, agentId=${agentId}`);

    // ── Basic validation ──────────────────────────────────────────────────────
    if (!userAddress || !agentId) {
      return NextResponse.json(
        { error: 'Missing required fields: userAddress, agentId' },
        { status: 400 },
      );
    }

    if (!_PROXY_ADDR) {
      return NextResponse.json(
        { error: 'Marketplace contract address not configured on server' },
        { status: 503 },
      );
    }

    // ── Layer 1: On-chain license check (frontend boundary) ───────────────────
    // Licenses are now issued to the Fee Wallet address by the /agents/purchase flow.
    // Use feeWalletAddress when provided; fall back to userAddress for backward compat.
    // Defense-in-depth only — the ENGINE does its own authoritative check.
    const licenseCheckAddress = (feeWalletAddress || userAddress) as Address;
    console.log(`[fe-deploy-2] Checking userLicenses on-chain via RPC for ${licenseCheckAddress}...`);
    let hasLicense = false;
    let rpcAvailable = true;
    try {
      hasLicense = await _publicClient.readContract({
        address: _PROXY_ADDR,
        abi: _LICENSE_ABI,
        functionName: 'userLicenses',
        args: [licenseCheckAddress, agentId as string],
      }) as boolean;
      console.log(`[fe-deploy-2-ok] On-chain license result: hasLicense=${hasLicense}`);
    } catch (err) {
      console.warn('[fe-deploy-2-warn] License read failed (RPC unavailable) — deferring to ENGINE:', (err as Error).message?.split('\n')[0]);
      rpcAvailable = false;
    }

    // Only hard-reject if the RPC succeeded AND confirmed no license
    if (rpcAvailable && !hasLicense) {
      return NextResponse.json(
        {
          error: `Unauthorized: address ${licenseCheckAddress} does not hold a license for agent "${agentId}".`,
          hint: 'Purchase a license in the Marketplace before deploying.',
        },
        { status: 403 },
      );
    }

    // ── Layer 1b: On-chain Gateway Spending Balance check (min 0.0001 USDC = 100 units) ──
    const GATEWAY_ADDR = (process.env.GATEWAY_ADDRESS || '0x0077777d7EBA4688BDeF3E311b846F25870A19B9') as Address;
    const USDC_ADDR = (process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000') as Address;
    const GW_ABI = parseAbi(['function availableBalance(address token, address depositor) external view returns (uint256)']);
    
    let hasMinGatewayBalance = false;
    const addressesToCheck = [userAddress, feeWalletAddress].filter(Boolean);

    for (const addr of addressesToCheck) {
      try {
        const checksummed = getAddress(addr);
        const rawBal = await _publicClient.readContract({
          address: GATEWAY_ADDR,
          abi: GW_ABI,
          functionName: 'availableBalance',
          args: [USDC_ADDR, checksummed],
        }) as bigint;
        console.log(`[fe-deploy-gw] Gateway on-chain balance for ${checksummed}: ${rawBal} atomic units`);
        if (rawBal >= 100n) { // 100 atomic units = 0.0001 USDC
          hasMinGatewayBalance = true;
          break;
        }
      } catch (err: any) {
        console.warn('[fe-deploy-gw-warn] Gateway on-chain balance read error:', err.message);
      }
    }

    // Fallback: check Circle Gateway REST API
    if (!hasMinGatewayBalance) {
      try {
        const circleRes = await fetch('https://gateway-api-testnet.circle.com/v1/balances', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: 'USDC',
            sources: [{ depositor: getAddress(userAddress), domain: 26 }],
          }),
        });
        if (circleRes.ok) {
          const circleData = await circleRes.json();
          const found = parseFloat(circleData?.balances?.[0]?.balance ?? '0');
          if (found >= 0.0001) {
            hasMinGatewayBalance = true;
          }
        }
      } catch (circleErr: any) {
        console.warn('[fe-deploy-gw-warn] Circle API balance check error:', circleErr.message);
      }
    }

    if (!hasMinGatewayBalance) {
      return NextResponse.json(
        {
          success: false,
          error: 'INSUFFICIENT_GATEWAY_BALANCE: Minimum 0.0001 USDC required in Gateway Spending Account. Please deposit funds on the Billing page to activate.',
        },
        { status: 402 }
      );
    }

    // ── Layer 2: Forward to ENGINE with original Authorization header ──────────
    const authHeader = request.headers.get('Authorization') ?? request.headers.get('authorization');
    if (!authHeader) {
      return NextResponse.json(
        { error: 'Missing Authorization header. Provide your Circle session token as Bearer.' },
        { status: 401 },
      );
    }

    console.log(`[fe-deploy-3] Forwarding request to ENGINE at ${ENGINE_URL}/agents/deploy...`);
    let engineRes: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      engineRes = await fetch(`${ENGINE_URL}/agents/deploy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
        },
        body: JSON.stringify({ agentId, intervalSeconds }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      console.log(`[fe-deploy-3-ok] ENGINE response status: ${engineRes.status}`);
    } catch (err: any) {
      console.error('[fe-deploy-3-fail] ENGINE unreachable:', err.message);
      return NextResponse.json(
        { error: `Connection failed: Aethel Engine at ${ENGINE_URL} is unreachable. Ensure the ENGINE server is running (cd ENGINE && npm run dev).` },
        { status: 502 },
      );
    }

    const data = await engineRes.json();
    return NextResponse.json(data, { status: engineRes.status });

  } catch (err: any) {
    console.error('[/api/agents/deploy] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── GET /api/agents/deploy?userAddress=0x... ──────────────────────────────────
// Proxy for GET /agents/status — returns daemon running status for a user.

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userAddress = searchParams.get('userAddress') ?? '';

    const qs = userAddress ? `?userAddress=${encodeURIComponent(userAddress)}` : '';

    let engineRes: Response;
    try {
      engineRes = await fetch(`${ENGINE_URL}/agents/status${qs}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err: any) {
      return NextResponse.json(
        { error: `Connection failed: Aethel Engine at ${ENGINE_URL} is unreachable.` },
        { status: 502 },
      );
    }

    const data = await engineRes.json();
    return NextResponse.json(data, { status: engineRes.status });
  } catch (err: any) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── DELETE /api/agents/deploy — stop a daemon ─────────────────────────────────
// Proxies to POST /agents/stop, forwarding the original Authorization header.

export async function DELETE(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization') ?? request.headers.get('authorization');
    if (!authHeader) {
      return NextResponse.json({ error: 'Missing Authorization header.' }, { status: 401 });
    }

    let engineRes: Response;
    try {
      engineRes = await fetch(`${ENGINE_URL}/agents/stop`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
        },
        body: JSON.stringify({}),
      });
    } catch (err: any) {
      return NextResponse.json(
        { error: `Connection failed: Aethel Engine at ${ENGINE_URL} is unreachable.` },
        { status: 502 },
      );
    }

    const data = await engineRes.json();
    return NextResponse.json(data, { status: engineRes.status });
  } catch (err: any) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
