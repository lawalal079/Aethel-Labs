import { NextResponse } from "next/server";
import { createPublicClient, http, parseAbi, type Address } from "viem";

// ─── Read-only viem client for on-chain license verification ─────────────────

const _CHAIN_ID   = parseInt(process.env.NEXT_PUBLIC_CHAIN_ID ?? '5042002', 10);
const _RPC_URL    = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://rpc.testnet.arc.network';
const _PROXY_ADDR = (process.env.NEXT_PUBLIC_MARKETPLACE_ADDRESS ?? '') as Address;

const _arcChain = {
  id: _CHAIN_ID,
  name: process.env.NEXT_PUBLIC_CHAIN_NAME ?? 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: { default: { http: [_RPC_URL] }, public: { http: [_RPC_URL] } },
} as const;

const _publicClient = createPublicClient({ chain: _arcChain as any, transport: http(_RPC_URL) });

const _LICENSE_ABI = parseAbi([
  'function userLicenses(address, string) view returns (bool)',
]);
const CIRCLE_BASE_URL = process.env.NEXT_PUBLIC_CIRCLE_BASE_URL ?? "https://api.circle.com";
const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY as string;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, ...params } = body ?? {};

    if (!action) {
      return NextResponse.json({ error: "Missing action" }, { status: 400 });
    }

    switch (action) {
      case "createDeviceToken": {
        const { deviceId } = params;
        if (!deviceId) {
          return NextResponse.json(
            { error: "Missing deviceId" },
            { status: 400 },
          );
        }

        const response = await fetch(
          `${CIRCLE_BASE_URL}/v1/w3s/users/social/token`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${CIRCLE_API_KEY}`,
            },
            body: JSON.stringify({
              idempotencyKey: crypto.randomUUID(),
              deviceId,
            }),
          },
        );

        const data = await response.json();

        if (!response.ok) {
          console.warn("Circle API error (createDeviceToken):", response.status, data);
          return NextResponse.json(data, { status: response.status });
        }

        // Returns: { deviceToken, deviceEncryptionKey }
        return NextResponse.json(data.data, { status: 200 });
      }

      case "initializeUser": {
        const { userToken } = params;
        if (!userToken) {
          return NextResponse.json(
            { error: "Missing userToken" },
            { status: 400 },
          );
        }

        const response = await fetch(
          `${CIRCLE_BASE_URL}/v1/w3s/user/initialize`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${CIRCLE_API_KEY}`,
              "X-User-Token": userToken,
            },
            body: JSON.stringify({
              idempotencyKey: crypto.randomUUID(),
              accountType: "EOA",
              blockchains: ["ARC-TESTNET"],
            }),
          },
        );

        const data = await response.json();

        if (!response.ok) {
          console.warn("Circle API error (initializeUser):", response.status, data);
          // Pass through Circle error payload (e.g. code 155106: user already initialized)
          return NextResponse.json(data, { status: response.status });
        }

        // Returns: { challengeId }
        return NextResponse.json(data.data, { status: 200 });
      }

      case "listWallets": {
        const { userToken } = params;
        if (!userToken) {
          return NextResponse.json(
            { error: "Missing userToken" },
            { status: 400 },
          );
        }

        const response = await fetch(`${CIRCLE_BASE_URL}/v1/w3s/wallets`, {
          method: "GET",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            Authorization: `Bearer ${CIRCLE_API_KEY}`,
            "X-User-Token": userToken,
          },
        });

        const data = await response.json();

        if (!response.ok) {
          console.warn("Circle API error (listWallets):", response.status, data);
          return NextResponse.json(data, { status: response.status });
        }

        // Returns: { wallets: [...] }
        return NextResponse.json(data.data, { status: 200 });
      }

      case "getTokenBalance": {
        const { userToken, walletId } = params;
        if (!userToken || !walletId) {
          return NextResponse.json(
            { error: "Missing userToken or walletId" },
            { status: 400 },
          );
        }

        const response = await fetch(
          `${CIRCLE_BASE_URL}/v1/w3s/wallets/${walletId}/balances`,
          {
            method: "GET",
            headers: {
              accept: "application/json",
              Authorization: `Bearer ${CIRCLE_API_KEY}`,
              "X-User-Token": userToken,
            },
          },
        );

        const data = await response.json();

        if (!response.ok) {
          console.warn("Circle API error (getTokenBalance):", response.status, data);
          return NextResponse.json(data, { status: response.status });
        }

        // Returns: { tokenBalances: [...] }
        return NextResponse.json(data.data, { status: 200 });
      }

      case "sendContractTransaction": {
        const { userToken, walletId, contractAddress, callData } = params;
        if (!userToken || !walletId || !contractAddress || !callData) {
          return NextResponse.json(
            { error: "Missing required parameters: userToken, walletId, contractAddress, callData" },
            { status: 400 },
          );
        }

        const response = await fetch(
          `${CIRCLE_BASE_URL}/v1/w3s/user/transactions/contractExecution`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${CIRCLE_API_KEY}`,
              "X-User-Token": userToken,
            },
            body: JSON.stringify({
              idempotencyKey: crypto.randomUUID(),
              walletId,
              contractAddress,
              callData,
              feeLevel: "MEDIUM",
            }),
          },
        );

        const data = await response.json();
        if (!response.ok) {
          console.warn("Circle API error (sendContractTransaction):", response.status, data);
          return NextResponse.json(data, { status: response.status });
        }

        // Returns: { challengeId, id }
        return NextResponse.json(data.data, { status: 200 });
      }

      case "getTransaction": {
        const { userToken, id } = params;
        if (!userToken || !id) {
          return NextResponse.json(
            { error: "Missing userToken or transaction id" },
            { status: 400 },
          );
        }

        const response = await fetch(
          `${CIRCLE_BASE_URL}/v1/w3s/transactions/${id}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${CIRCLE_API_KEY}`,
              "X-User-Token": userToken,
            },
          },
        );

        const data = await response.json();
        if (!response.ok) {
          console.warn("Circle API error (getTransaction):", response.status, data);
          return NextResponse.json(data, { status: response.status });
        }

        // Returns: the transaction object, including status, txHash, etc.
        return NextResponse.json(data.data, { status: 200 });
      }

      case "signTypedData": {
        const { userToken, walletId, typedData } = params;
        if (!userToken || !walletId || !typedData) {
          return NextResponse.json(
            { error: "Missing required parameters: userToken, walletId, typedData" },
            { status: 400 },
          );
        }

        const response = await fetch(
          `${CIRCLE_BASE_URL}/v1/w3s/user/sign/typedData`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${CIRCLE_API_KEY}`,
              "X-User-Token": userToken,
            },
            body: JSON.stringify({
              idempotencyKey: crypto.randomUUID(),
              walletId,
              data: JSON.stringify(typedData),
            }),
          },
        );

        const data = await response.json();
        if (!response.ok) {
          console.warn("Circle API error (signTypedData):", response.status, data);
          return NextResponse.json(data, { status: response.status });
        }

        // Returns: { challengeId, id }
        return NextResponse.json(data.data, { status: 200 });
      }

      case "getSignature": {
        const { userToken, id } = params;
        if (!userToken || !id) {
          return NextResponse.json(
            { error: "Missing userToken or signature id" },
            { status: 400 },
          );
        }

        const response = await fetch(
          `${CIRCLE_BASE_URL}/v1/w3s/user/challenges/${id}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${CIRCLE_API_KEY}`,
              "X-User-Token": userToken,
            },
          },
        );

        const data = await response.json();
        if (!response.ok) {
          console.warn("Circle API error (getSignature/challenges):", response.status, data);
          return NextResponse.json(data, { status: response.status });
        }

        const challenge = data.data?.challenge ?? data.data;
        const state = challenge?.state ?? challenge?.status;
        console.log("[endpoints] Challenge poll state:", state, "| raw keys:", Object.keys(challenge ?? {}));

        // Extract the signature once the challenge is COMPLETE
        const signature =
          challenge?.signedData?.signature ??
          challenge?.signature ??
          challenge?.result?.signature ??
          null;

        return NextResponse.json({ state, status: state, signature }, { status: 200 });
      }

      case "listTransactions": {
        const { userToken } = params;
        if (!userToken) {
          return NextResponse.json(
            { error: "Missing userToken" },
            { status: 400 },
          );
        }

        const response = await fetch(`${CIRCLE_BASE_URL}/v1/w3s/transactions`, {
          method: "GET",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            Authorization: `Bearer ${CIRCLE_API_KEY}`,
            "X-User-Token": userToken,
          },
        });

        const data = await response.json();
        if (!response.ok) {
          console.warn("Circle API error (listTransactions):", response.status, data);
          return NextResponse.json(data, { status: response.status });
        }

        // Returns: { transactions: [...] }
        return NextResponse.json(data.data, { status: 200 });
      }

      case "executeDirective": {
        // Secure console proxy: verifies on-chain license ownership before routing
        const { userAddress, agentId, directive, txHash } = params;

        if (!userAddress || !agentId || !directive) {
          return NextResponse.json(
            { error: "Missing required params: userAddress, agentId, directive" },
            { status: 400 },
          );
        }

        if (!_PROXY_ADDR) {
          return NextResponse.json(
            { error: "Marketplace contract address not configured on server" },
            { status: 503 },
          );
        }

        // Verify on-chain license ownership
        let hasLicense = false;
        try {
          hasLicense = await _publicClient.readContract({
            address: _PROXY_ADDR,
            abi: _LICENSE_ABI,
            functionName: 'userLicenses',
            args: [userAddress as Address, agentId as string],
          }) as boolean;
        } catch (err) {
          console.warn('[executeDirective] License read failed:', err);
          return NextResponse.json(
            { error: 'Unable to verify license on-chain. RPC unavailable.' },
            { status: 503 },
          );
        }

        if (!hasLicense) {
          return NextResponse.json(
            { error: `Unauthorized: address ${userAddress} does not hold a license for agent "${agentId}".` },
            { status: 403 },
          );
        }

        // License verified — route to Æthel Engine dispatcher!
        const engineUrl = process.env.NEXT_PUBLIC_ENGINE_URL || 'http://localhost:4000';
        try {
          const dispatchRes = await fetch(`${engineUrl}/dispatch`, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'x-verified-client-address': userAddress
            },

            body: JSON.stringify({
              intent: directive,
              agentType: agentId,
              txHash: txHash || '0x' + '0'.repeat(40),
              buyerAddress: userAddress
            })
          });

          const dispatchData = await dispatchRes.json();

          if (!dispatchRes.ok) {
            return NextResponse.json(
              { error: dispatchData.error || 'Engine dispatch failed' },
              { status: dispatchRes.status }
            );
          }

          return NextResponse.json(dispatchData, { status: 200 });
        } catch (dispatchErr) {
          console.error('[executeDirective] Failed to reach engine:', dispatchErr);
          return NextResponse.json(
            { error: `Connection failed: Æthel Engine at ${engineUrl} is unreachable.` },
            { status: 502 }
          );
        }
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 },
        );
    }
  } catch (error) {
    console.log("Error in /api/endpoints:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
