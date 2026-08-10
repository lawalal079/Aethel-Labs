import { NextResponse } from 'next/server';

const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL ?? 'http://localhost:4000';

// POST /api/gateway-withdraw — proxies to ENGINE POST /agents/gateway-withdraw
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const auth = req.headers.get('authorization');
    if (auth) headers['authorization'] = auth;

    const res = await fetch(`${ENGINE_URL}/agents/gateway-withdraw`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    console.error('[/api/gateway-withdraw] Error proxying to engine:', err);
    return NextResponse.json(
      { error: `Connection failed: Aethel Engine at ${ENGINE_URL} is unreachable.` },
      { status: 502 }
    );
  }
}

// GET /api/gateway-withdraw — proxies to ENGINE GET /agents/gateway-withdraw
export async function GET(req: Request) {
  try {
    const { search } = new URL(req.url);
    const res = await fetch(`${ENGINE_URL}/agents/gateway-withdraw${search}`, {
      method: 'GET',
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    console.error('[/api/gateway-withdraw] Error proxying to engine:', err);
    return NextResponse.json(
      { error: `Connection failed: Aethel Engine at ${ENGINE_URL} is unreachable.` },
      { status: 502 }
    );
  }
}
