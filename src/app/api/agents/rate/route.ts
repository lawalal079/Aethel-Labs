import { NextRequest, NextResponse } from 'next/server';

const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL || 'http://localhost:4000';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const agentId = searchParams.get('agentId') || '';

  try {
    const url = agentId
      ? `${ENGINE_URL}/agents/ratings?agentId=${encodeURIComponent(agentId)}`
      : `${ENGINE_URL}/agents/ratings`;
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    let authHeader = req.headers.get('Authorization') ?? req.headers.get('authorization');
    if (!authHeader && body?.userAddress) {
      authHeader = `Bearer ${body.userAddress}`;
    }

    if (!authHeader) {
      return NextResponse.json(
        { success: false, error: 'Missing Authorization header. Provide your Circle session token as Bearer.' },
        { status: 401 }
      );
    }

    const res = await fetch(`${ENGINE_URL}/agents/rate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
