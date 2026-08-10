import { NextResponse } from 'next/server';

const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL || 'http://localhost:4000';

/**
 * POST /api/agents/gateway-deposit
 * Forwards to ENGINE POST /agents/gateway-deposit
 * Body: { amountUsdc: string }
 * Auth: Circle W3S Bearer token in Authorization header (passed through)
 */
export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const body = await req.json();

    const engineRes = await fetch(`${ENGINE_URL}/agents/gateway-deposit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify(body),
    });

    const data = await engineRes.json();

    if (!engineRes.ok) {
      return NextResponse.json(data, { status: engineRes.status });
    }

    return NextResponse.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal server error';
    console.error('[api/agents/gateway-deposit] Error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
