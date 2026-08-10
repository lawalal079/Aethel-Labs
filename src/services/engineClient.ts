/**
 * engineClient.ts
 *
 * Client utility to interact with the Æthel Engine dispatcher service.
 * Used by the UI when a user clicks 'Deploy' on a purchased agent.
 */

export interface DispatchResponse {
  success: boolean;
  status?: 'dispatching' | 'success' | 'error';
  agentId?: string;
  agentTitle?: string;
  result?: string;
  error?: string;
  meta?: {
    verified: boolean;
    amountPaid?: string;
    blockNumber?: string;
  };
}

/**
 * Dispatches an intent to the backend engine for verification and execution.
 *
 * @param intent - What the user wants the agent to do
 * @param agentType - The string ID of the agent (e.g. 'trading_bot_core')
 * @param txHash - Transaction hash of the USDC escrow purchase on ARC Testnet
 * @param buyerAddress - (Optional) Wallet address of the buyer
 * @param activeUserIdentifier - The live, verified auth identity string. Must be extracted
 *   from the active auth state at call-site: `user?.wallet?.address || circleUserAddress || 'anonymous'`
 * @returns Promise<DispatchResponse>
 */
export async function dispatchTask(
  intent: string,
  agentType: string,
  txHash: string,
  buyerAddress?: string,
  activeUserIdentifier?: string
): Promise<DispatchResponse> {
  const engineUrl = process.env.NEXT_PUBLIC_ENGINE_URL || 'http://localhost:4000';
  const dispatchEndpoint = `${engineUrl}/dispatch`;

  // Resolve the verified identity header — fall back to buyerAddress if not explicitly provided
  const verifiedIdentity = activeUserIdentifier || buyerAddress || 'anonymous';

  console.log(`[engineClient] Dispatching agent task to ${dispatchEndpoint}...`, {
    agentType,
    txHash,
    intent,
    buyerAddress,
    verifiedIdentity,
  });

  try {
    const response = await fetch(dispatchEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // ── SESSION AIR-GAP: Forward verified identity on every dispatch ──────
        'x-verified-client-address': verifiedIdentity,
      },
      body: JSON.stringify({
        intent,
        agentType,
        txHash,
        buyerAddress,
      }),
    });

    // Handle HTTP status code cases
    if (response.status === 402) {
      return {
        success: false,
        error: 'Payment Required: The engine could not verify your escrow payment transaction.',
        meta: { verified: false },
      };
    }

    // Strict session air-gap: 403 means the address has not licensed this agent
    if (response.status === 403) {
      return {
        success: false,
        error: 'HTTP 403 Unauthorized: Your wallet address does not hold a license for this agent. Please purchase a deployment license from the marketplace.',
        meta: { verified: false },
      };
    }


    let data: DispatchResponse;
    try {
      data = await response.json();
    } catch (parseErr) {
      return {
        success: false,
        error: `Invalid response format from engine (HTTP ${response.status}).`,
      };
    }

    // Handle successful/unsuccessful dispatch payload structures
    if (!response.ok) {
      // If the engine verified field is false, it's a verification/payment failure
      if (data.meta?.verified === false) {
        return {
          success: false,
          error: data.error ?? 'Payment verification failed: Check your transaction status.',
          meta: data.meta,
        };
      }
      return {
        success: false,
        error: data.error ?? `Engine dispatch failed with status HTTP ${response.status}`,
        meta: data.meta,
      };
    }

    return data;
  } catch (error) {
    console.error('[engineClient] Network or dispatcher connection error:', error);
    
    // Catch fetch/network errors (dispatcher server down/offline)
    return {
      success: false,
      error: `Network error: Unable to connect to Æthel Engine at ${engineUrl}. Make sure the backend engine service is running.`,
    };
  }
}
