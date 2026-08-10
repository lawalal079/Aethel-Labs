import { NextRequest, NextResponse } from 'next/server';

const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL ?? 'http://localhost:4000';

// ── POST /api/agents/fee-wallet ──────────────────────────────────────────────
// Withdraws USDC from Fee Wallet to user's Agent Wallet.
// Forwards Authorization header to ENGINE for verification.

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization') ?? request.headers.get('authorization');
    if (!authHeader) {
      return NextResponse.json({ error: 'Missing Authorization header.' }, { status: 401 });
    }

    const body = await request.json();
    const { amount, destinationAddress, idempotencyKey } = body ?? {};

    if (!amount || parseFloat(amount) <= 0) {
      return NextResponse.json({ error: 'Valid withdrawal amount is required.' }, { status: 400 });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    let engineRes: Response;
    try {
      engineRes = await fetch(`${ENGINE_URL}/agents/fee-wallet/withdraw`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
        },
        body: JSON.stringify({ amount, destinationAddress, idempotencyKey }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
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
