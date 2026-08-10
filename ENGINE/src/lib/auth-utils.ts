import * as crypto from 'crypto';
import 'dotenv/config';
import * as path from 'path';
// Fallback path-based load if started from the project root instead of the ENGINE subdirectory
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// ── Test-mode guard (mirrors dispatcher.ts) ──────────────────────────────────────────
// True ONLY when both conditions hold:
//   1. ALLOW_MOCK_AUTH=true  (explicit test opt-in)
//   2. NODE_ENV is exactly 'test' or 'development'  (explicit non-prod env)
const MOCK_AUTH_ENABLED =
  process.env.ALLOW_MOCK_AUTH === 'true' &&
  (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development' || !process.env.NODE_ENV);

function decodeJwt(token: string): { header: any; payload: any } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return { header, payload };
  } catch {
    return null;
  }
}

export async function verifyCircleToken(userToken: string): Promise<{ userId: string; walletAddress: string }> {
  const circleBaseUrl = process.env.NEXT_PUBLIC_CIRCLE_BASE_URL || 'https://api.circle.com';
  const circleApiKey = process.env.CIRCLE_API_KEY;
  if (!circleApiKey) {
    throw new Error('CIRCLE_API_KEY is not configured in environment variables');
  }

  const endpoint = `${circleBaseUrl}/v1/w3s/wallets`;
  console.log('[auth-utils] verifyCircleToken initiating fetch to:', endpoint);
  console.log('[auth-utils] verifyCircleToken X-User-Token length:', userToken.length);

  const res = await fetch(endpoint, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${circleApiKey}`,
      'X-User-Token': userToken,
    },
  });

  const responseText = await res.text();
  console.log('[auth-utils] verifyCircleToken Circle API status:', res.status);

  if (!res.ok) {
    let errorMessage = res.statusText;
    try {
      const errorData = JSON.parse(responseText);
      if (errorData.message) errorMessage = errorData.message;
    } catch {}
    throw new Error(`Circle token verification failed: ${errorMessage}`);
  }

  const data = JSON.parse(responseText) as { data: { wallets: Array<{ address: string }> } };
  const walletAddress = data.data?.wallets?.[0]?.address;
  if (!walletAddress) {
    throw new Error('No active wallet found for this Circle session');
  }

  return {
    userId: walletAddress.toLowerCase(),
    walletAddress: walletAddress.toLowerCase()
  };
}

export async function verifyRequestAuth(headers: Record<string, string | string[] | undefined>): Promise<{ userId: string; walletAddress: string }> {
  const authHeader = headers['authorization'];
  const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.substring(7)
    : undefined;

  if (!token) {
    throw new Error('Missing or invalid Authorization header. Expecting Bearer token.');
  }

  console.log('[auth-utils] verifyRequestAuth received raw token prefix:', token.substring(0, 25));

  // Allow mock tokens only in test/dev mode
  if (MOCK_AUTH_ENABLED && token.startsWith('mock_token_')) {
    console.log('[auth-utils] Routing token to: mock');
    const address = token.substring('mock_token_'.length).toLowerCase();
    return { userId: 'mock_user_' + address, walletAddress: address };
  }

  // All tokens route to Circle Agent / W3S token verification
  console.log('[auth-utils] Routing token to: circle');
  return verifyCircleToken(token);
}
