/**
 * x402.ts
 *
 * Æthel Engine — Client-Side x402 Payment Negotiation Middleware
 *
 * Implements the buyer-side signature method: when an agent needs to trigger
 * a paid API (returning HTTP 402), this middleware detects it, signs the
 * EIP-3009 TransferWithAuthorization using the private key in .env, attaches
 * the header, and retries the request.
 */

import { ethers } from 'ethers';
import { randomBytes } from 'crypto';
import 'dotenv/config';

// Arc Testnet Defaults (as specified in documentation)
const DEFAULT_CHAIN_ID = 5042002;
const DEFAULT_VERIFYING_CONTRACT = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9'; // GatewayWallet on Arc Testnet

// EIP-3009 Typed Data Types (TransferWithAuthorization)
const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

/**
 * Executes a fetch request and automatically handles negotiation if the target
 * endpoint requires an x402 nanopayment.
 *
 * @param url The endpoint URL
 * @param options Standard RequestInit options
 * @returns Standard Response promise
 */
export async function fetchWithX402(url: string, options: RequestInit = {}): Promise<Response> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('[x402] PRIVATE_KEY environment variable is not defined in .env');
  }

  // 1. Send the initial request
  console.log(`[x402] Sending initial request to ${url}`);
  const initialResponse = await fetch(url, options);

  // 2. If not 402, return response directly (normal flow)
  if (initialResponse.status !== 402) {
    return initialResponse;
  }

  console.log(`[x402] HTTP 402 Payment Required received for: ${url}`);

  // 3. Extract the PAYMENT-REQUIRED header
  const paymentRequiredHeader = initialResponse.headers.get('PAYMENT-REQUIRED');
  if (!paymentRequiredHeader) {
    throw new Error('[x402] 402 response is missing required PAYMENT-REQUIRED header');
  }

  // 4. Decode the header (base64 encoded JSON)
  const decodedHeaderString = Buffer.from(paymentRequiredHeader, 'base64').toString('utf8');
  const paymentRequired = JSON.parse(decodedHeaderString);
  console.log(`[x402] Payment requirements:`, JSON.stringify(paymentRequired, null, 2));

  // 5. Locate accepted Gateway option matching "GatewayWalletBatched" or "exact" scheme
  const accepts = paymentRequired.accepts || [];
  const gatewayOption = accepts.find(
    (opt: any) => opt.extra?.name === 'GatewayWalletBatched' || opt.scheme === 'exact'
  );

  if (!gatewayOption) {
    throw new Error('[x402] No compatible Gateway/x402 payment option found in server requirements');
  }

  const payTo = gatewayOption.payTo;
  const rawAmount = gatewayOption.amount; // Base unit string (e.g. "10000" for 0.01 USDC)
  const amountBigInt = BigInt(rawAmount);

  // Parse chain ID from network string (e.g., "eip155:5042002")
  const networkStr = gatewayOption.network || `eip155:${DEFAULT_CHAIN_ID}`;
  const chainId = parseInt(networkStr.split(':')[1] || String(DEFAULT_CHAIN_ID), 10);

  // Retrieve verifying contract (GatewayWallet) address
  const verifyingContract = gatewayOption.extra?.verifyingContract || DEFAULT_VERIFYING_CONTRACT;

  console.log(`[x402] ─── Negotiation Parameters ─────────────────────────────────`);
  console.log(`[x402] Target Network  : Chain ID ${chainId}`);
  console.log(`[x402] Gateway Wallet  : ${verifyingContract}`);
  console.log(`[x402] Seller Address  : ${payTo}`);
  console.log(`[x402] Amount (Base)   : ${amountBigInt.toString()} base units (6 decimals)`);
  console.log(`[x402] ───────────────────────────────────────────────────────────`);

  // 6. Sign the EIP-3009 TransferWithAuthorization structure
  const wallet = new ethers.Wallet(privateKey);
  const fromAddress = wallet.address;

  const domain = {
    name: 'GatewayWalletBatched',
    version: '1',
    chainId: chainId,
    verifyingContract: verifyingContract,
  };

  const message = {
    from: fromAddress,
    to: payTo,
    value: amountBigInt,
    validAfter: 0n,
    // EIP-3009 validBefore must be at least 3 days in the future (we use 5 days)
    validBefore: BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 5),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  };

  console.log(`[x402] Generating EIP-3009 cryptographic signature...`);
  const signature = await wallet.signTypedData(domain, EIP3009_TYPES, message);
  console.log(`[x402] Signature generated successfully.`);

  // 7. Construct standard Payment-Signature payload
  const paymentPayload = {
    x402Version: 2,
    payload: {
      authorization: {
        from: message.from,
        to: message.to,
        value: message.value.toString(),
        validAfter: message.validAfter.toString(),
        validBefore: message.validBefore.toString(),
        nonce: message.nonce,
      },
      signature: signature,
    },
    resource: paymentRequired.resource?.url || url,
    accepted: gatewayOption,
  };

  const encodedPayload = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

  // 8. Retry HTTP request with Payment-Signature authorization header
  console.log(`[x402] Retrying request to ${url} with EIP-3009 signed header...`);
  
  const headers = new Headers(options.headers || {});
  headers.set('Payment-Signature', encodedPayload);

  const finalResponse = await fetch(url, {
    ...options,
    headers: headers,
  });

  console.log(`[x402] Retry completed with status: ${finalResponse.status}`);
  return finalResponse;
}
