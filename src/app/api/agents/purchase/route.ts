/**
 * /api/agents/purchase — Next.js App Router API route
 *
 * Proxies to ENGINE POST /agents/purchase.
 * The ENGINE verifies the Circle auth token, resolves the Fee Wallet,
 * and executes USDC.approve + purchaseAgent server-side (entity-secret signed).
 * No browser challenge / executeChallenge is needed.
 */

import { NextRequest, NextResponse } from 'next/server';

const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL ?? 'http://localhost:4000';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { agentId } = body ?? {};

    if (!agentId) {
      return NextResponse.json(
        { error: 'Missing required field: agentId' },
        { status: 400 },
      );
    }

    const authHeader =
      request.headers.get('Authorization') ??
      request.headers.get('authorization');

    if (!authHeader) {
      return NextResponse.json(
        { error: 'Missing Authorization header. Provide your Circle session token as Bearer.' },
        { status: 401 },
      );
    }

    let engineRes: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120_000); // 2 min — approve + purchase can take ~60s

      engineRes = await fetch(`${ENGINE_URL}/agents/purchase`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
        },
        body: JSON.stringify({ agentId }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (err: any) {
      console.error('[/api/agents/purchase] ENGINE unreachable:', err.message);
      return NextResponse.json(
        { error: `Connection failed: Aethel Engine at ${ENGINE_URL} is unreachable. Ensure the ENGINE server is running.` },
        { status: 502 },
      );
    }

    const data = await engineRes.json();
    return NextResponse.json(data, { status: engineRes.status });
  } catch (err: any) {
    console.error('[/api/agents/purchase] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
