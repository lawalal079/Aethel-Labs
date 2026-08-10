import { NextRequest, NextResponse } from 'next/server';

const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL || 'http://localhost:4000';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const userAddress = searchParams.get('userAddress') || '';

  try {
    const res = await fetch(`${ENGINE_URL}/agents/transactions?userAddress=${encodeURIComponent(userAddress)}`, {
      cache: 'no-store',
    });

    if (!res.ok) {
      return NextResponse.json({ transactions: [] }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err: any) {
    console.error('[api/agents/transactions] Fetch error:', err.message);
    return NextResponse.json({ transactions: [] }, { status: 500 });
  }
}
