import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { privateKeyToAccount } from 'viem/accounts';

// ─── Circle Gateway config ────────────────────────────────────────────────────
const GATEWAY_API = 'https://gateway-api-testnet.circle.com';

// Arc Testnet constants (from GET /v1/info)
const ARC_DOMAIN       = 26;
const GATEWAY_WALLET   = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
const GATEWAY_MINTER   = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B';
const USDC_ARC         = '0x3600000000000000000000000000000000000000';

// Pad an EVM address or bytes32 hex string to 32-byte hex (bytes32)
function padAddress(addr: string): `0x${string}` {
  if (!addr) return '0x0000000000000000000000000000000000000000000000000000000000000000';
  const stripped = addr.startsWith('0x') ? addr.slice(2) : addr;
  return `0x${stripped.padStart(64, '0')}` as `0x${string}`;
}

// Clean TransferSpec to only include exact EIP-712 TransferSpec fields (removes Circle API extra estimate fields)
function cleanTransferSpec(rawSpec: any, depositorAddr: string, recipientAddr?: string) {
  const dep = padAddress(depositorAddr);
  const rec = padAddress(recipientAddr || depositorAddr);
  return {
    version: Number(rawSpec.version ?? 1),
    sourceDomain: Number(rawSpec.sourceDomain ?? ARC_DOMAIN),
    destinationDomain: Number(rawSpec.destinationDomain ?? ARC_DOMAIN),
    sourceContract: padAddress(rawSpec.sourceContract || GATEWAY_WALLET),
    destinationContract: padAddress(rawSpec.destinationContract || GATEWAY_MINTER),
    sourceToken: padAddress(rawSpec.sourceToken || USDC_ARC),
    destinationToken: padAddress(rawSpec.destinationToken || USDC_ARC),
    sourceDepositor: dep,
    destinationRecipient: rec,
    sourceSigner: dep, // Signer MUST match Depositor for valid signature recovery
    destinationCaller: padAddress(rawSpec.destinationCaller || '0'),
    value: rawSpec.value?.toString() || '0',
    salt: padAddress(rawSpec.salt || randomBytes(32).toString('hex')),
    hookData: (rawSpec.hookData || '0x') as `0x${string}`,
  };
}

// POST /api/gateway-withdraw
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { userAddress, amountUsdc } = body;
    let { signature, burnIntentSpec } = body;

    if (!userAddress || !amountUsdc) {
      return NextResponse.json(
        { error: 'Missing required fields: userAddress, amountUsdc' },
        { status: 400 }
      );
    }

    const parsed = parseFloat(amountUsdc);
    if (isNaN(parsed) || parsed <= 0) {
      return NextResponse.json({ error: 'Invalid amountUsdc' }, { status: 400 });
    }

    // If signature & burnIntentSpec are not provided by client, build & sign server-side using Fee Wallet key/Circle DCW
    if (!signature || !burnIntentSpec) {
      // 1. Resolve user's Fee Wallet by refId or address
      let feeWalletAddress = userAddress;
      let feeWalletId: string | null = null;
      try {
        const { getCircleClient, getOrAssignFeeWallet } = await import('../../../../ENGINE/src/lib/trading-wallet');
        
        // Try getting fee wallet by refId first
        let fw: { address: string; id: string } | null = null;
        try {
          fw = await getOrAssignFeeWallet(userAddress);
        } catch {}

        // If not found or if userAddress is already the fee wallet address itself, scan Circle client
        if (!fw || (fw.address.toLowerCase() !== userAddress.toLowerCase() && userAddress.toLowerCase().startsWith('0xa2d1') || userAddress.toLowerCase().startsWith('0x320f'))) {
          const client = getCircleClient();
          const walletsRes = await client.listWallets({});
          const match = (walletsRes.data?.wallets || []).find(
            (w: any) => w.address?.toLowerCase() === userAddress.toLowerCase() || w.refId?.toLowerCase() === userAddress.toLowerCase()
          );
          if (match) {
            fw = { address: match.address, id: match.id };
          }
        }

        if (fw) {
          feeWalletAddress = fw.address;
          feeWalletId = fw.id;
        }
      } catch (fwErr: any) {
        console.warn('[gateway-withdraw] Could not resolve Fee Wallet via Engine, using userAddress:', fwErr.message);
      }

      const amountBaseUnits = BigInt(Math.round(parsed * 1_000_000)).toString();

      // For Fee Wallet server-side Gateway withdrawal:
      // depositor & signer are feeWalletAddress
      // recipient is userAddress
      const spec = cleanTransferSpec({
        version: 1,
        sourceDomain: ARC_DOMAIN,
        destinationDomain: ARC_DOMAIN,
        sourceContract: GATEWAY_WALLET,
        destinationContract: GATEWAY_MINTER,
        sourceToken: USDC_ARC,
        destinationToken: USDC_ARC,
        sourceDepositor: feeWalletAddress,
        destinationRecipient: userAddress,
        sourceSigner: feeWalletAddress,
        destinationCaller: '0',
        value: amountBaseUnits,
        salt: randomBytes(32).toString('hex'),
        hookData: '0x',
      }, feeWalletAddress, userAddress);

      // Call Circle Gateway /v1/estimate
      const estimateRes = await fetch(`${GATEWAY_API}/v1/estimate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ spec }]),
      });

      const estimateData = await estimateRes.json();
      if (!estimateRes.ok) {
        const errorMsg = estimateData?.message ?? estimateData?.[0]?.message ?? 'Estimate failed';
        return NextResponse.json(
          { error: errorMsg, detail: estimateData },
          { status: estimateRes.status }
        );
      }

      const estimated = estimateData?.[0]?.burnIntent || estimateData.body?.[0]?.burnIntent;
      if (!estimated) {
        return NextResponse.json({ error: 'Estimate returned no burn intent' }, { status: 500 });
      }

      const formattedSpec = cleanTransferSpec(estimated.spec ?? spec, feeWalletAddress, userAddress);
      const estMaxFee = BigInt(estimated.maxFee || '0');
      const maxFeeBuffered = estMaxFee > BigInt(25_000) ? estMaxFee : BigInt(25_000);

      const eip712Data = {
        domain: {
          name: 'GatewayWallet',
          version: '1',
        },
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
          ],
          BurnIntent: [
            { name: 'maxBlockHeight', type: 'uint256' },
            { name: 'maxFee', type: 'uint256' },
            { name: 'spec', type: 'TransferSpec' },
          ],
          TransferSpec: [
            { name: 'version', type: 'uint32' },
            { name: 'sourceDomain', type: 'uint32' },
            { name: 'destinationDomain', type: 'uint32' },
            { name: 'sourceContract', type: 'bytes32' },
            { name: 'destinationContract', type: 'bytes32' },
            { name: 'sourceToken', type: 'bytes32' },
            { name: 'destinationToken', type: 'bytes32' },
            { name: 'sourceDepositor', type: 'bytes32' },
            { name: 'destinationRecipient', type: 'bytes32' },
            { name: 'sourceSigner', type: 'bytes32' },
            { name: 'destinationCaller', type: 'bytes32' },
            { name: 'value', type: 'uint256' },
            { name: 'salt', type: 'bytes32' },
            { name: 'hookData', type: 'bytes' },
          ],
        },
        primaryType: 'BurnIntent',
        message: {
          maxBlockHeight: estimated.maxBlockHeight.toString(),
          maxFee: maxFeeBuffered.toString(),
          spec: formattedSpec,
        },
      };

      if (feeWalletId) {
        // Sign via Circle W3S Developer-Controlled Wallet API
        const { getCircleClient } = await import('../../../../ENGINE/src/lib/trading-wallet');
        const circleClient = getCircleClient();
        console.log('[gateway-withdraw] Signing typed data via Circle W3S for feeWalletId:', feeWalletId, 'address:', feeWalletAddress);
        const signRes = await circleClient.signTypedData({
          walletId: feeWalletId,
          data: JSON.stringify(eip712Data),
        });
        signature = (signRes.data as any)?.signature;
        console.log('[gateway-withdraw] Produced signature:', signature);
      } else {
        // Fallback to server private key
        const pk = process.env.PRIVATE_KEY;
        if (!pk) {
          return NextResponse.json({ error: 'PRIVATE_KEY not configured for server signing' }, { status: 500 });
        }
        const formattedPk = (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`;
        const account = privateKeyToAccount(formattedPk);
        console.log('[gateway-withdraw] Falling back to privateKey account:', account.address);
        signature = await account.signTypedData({
          domain: eip712Data.domain,
          types: eip712Data.types as any,
          primaryType: 'BurnIntent',
          message: {
            maxBlockHeight: BigInt(estimated.maxBlockHeight),
            maxFee: maxFeeBuffered,
            spec: {
              ...formattedSpec,
              value: BigInt(formattedSpec.value),
            },
          },
        });
      }

      burnIntentSpec = {
        maxBlockHeight: estimated.maxBlockHeight.toString(),
        maxFee: maxFeeBuffered.toString(),
        spec: formattedSpec,
      };
    }

    // Submit signed BurnIntent to Circle Gateway Forwarder
    const transferRes = await fetch(`${GATEWAY_API}/v1/transfer?enableForwarder=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        {
          burnIntent: burnIntentSpec,
          signature,
        },
      ]),
    });

    const transferData = await transferRes.json();

    if (!transferRes.ok) {
      console.error('[gateway-withdraw] Circle Gateway error:', transferRes.status, transferData);
      return NextResponse.json(
        { error: transferData?.message ?? 'Circle Gateway transfer failed', detail: transferData },
        { status: transferRes.status }
      );
    }

    const transferId = transferData?.transferId;

    // Poll Circle Gateway /v1/transfer/{transferId} for up to 10s to verify forwarder execution
    let finalStatus = 'pending';
    let pollDetail: any = null;
    if (transferId) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const pollRes = await fetch(`${GATEWAY_API}/v1/transfer/${transferId}`);
          if (pollRes.ok) {
            pollDetail = await pollRes.json();
            finalStatus = pollDetail?.status || 'pending';
            if (finalStatus === 'completed' || finalStatus === 'failed') {
              break;
            }
          }
        } catch (pollErr) {
          console.warn('[gateway-withdraw] Polling error:', pollErr);
        }
      }
    }

    if (finalStatus === 'failed') {
      const failureReason = pollDetail?.forwardingDetails?.failureReason || 'ON_CHAIN_FAILURE';
      return NextResponse.json(
        {
          error: `Circle Gateway Forwarder relayer failed to execute on-chain (${failureReason}). Your funds were NOT deducted and remain safe in your Gateway balance.`,
          status: 'failed',
          transferId,
          detail: pollDetail,
        },
        { status: 400 }
      );
    }

    // Auto-record completed withdrawal to transaction ledger
    try {
      await fetch('http://localhost:4000/agents/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: 'system',
          agent_name: 'Circle Gateway',
          tx_type: 'Gateway Withdrawal',
          cost_usdc: amountUsdc,
          status: finalStatus === 'completed' ? 'SUCCESS' : 'PENDING',
          tx_hash: transferId ?? '',
          timestamp: new Date().toISOString(),
        }),
      });
    } catch { /* ignore */ }

    return NextResponse.json({
      ...transferData,
      status: finalStatus,
      pollDetail,
    });
  } catch (err: unknown) {
    console.error('[gateway-withdraw] Unexpected error:', err);
    const msg = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// GET /api/gateway-withdraw?action=estimate&userAddress=0x...&amountUsdc=1.5
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const action      = searchParams.get('action');
    const userAddress = searchParams.get('userAddress');
    const amountUsdc  = searchParams.get('amountUsdc');

    if (action !== 'estimate') {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
    if (!userAddress || !amountUsdc) {
      return NextResponse.json({ error: 'Missing userAddress or amountUsdc' }, { status: 400 });
    }

    const parsed = parseFloat(amountUsdc);
    if (isNaN(parsed) || parsed <= 0) {
      return NextResponse.json({ error: 'Invalid amountUsdc' }, { status: 400 });
    }

    const amountBaseUnits = BigInt(Math.round(parsed * 1_000_000)).toString();

    const spec = cleanTransferSpec({
      version: 1,
      sourceDomain: ARC_DOMAIN,
      destinationDomain: ARC_DOMAIN,
      sourceContract: GATEWAY_WALLET,
      destinationContract: GATEWAY_MINTER,
      sourceToken: USDC_ARC,
      destinationToken: USDC_ARC,
      sourceDepositor: userAddress,
      destinationRecipient: userAddress,
      sourceSigner: userAddress,
      destinationCaller: '0',
      value: amountBaseUnits,
      salt: randomBytes(32).toString('hex'),
      hookData: '0x',
    }, userAddress);

    let estimateRes: Response;
    try {
      estimateRes = await fetch(`${GATEWAY_API}/v1/estimate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ spec }]),
      });
    } catch (fetchErr: any) {
      console.error('[gateway-withdraw] Network fetch error to Circle Gateway API:', fetchErr.message);
      return NextResponse.json(
        { error: `Circle Gateway API network error: ${fetchErr.message}` },
        { status: 502 }
      );
    }

    const estimateData = await estimateRes.json();
    if (!estimateRes.ok) {
      console.error('[gateway-withdraw] Estimate error:', estimateRes.status, estimateData);
      return NextResponse.json(
        { error: estimateData?.message ?? 'Estimate failed', detail: estimateData },
        { status: estimateRes.status }
      );
    }

    const estimated = estimateData?.[0]?.burnIntent || estimateData.body?.[0]?.burnIntent;
    if (!estimated) {
      return NextResponse.json({ error: 'Estimate returned no burn intent' }, { status: 500 });
    }

    const cleanedSpec = cleanTransferSpec(estimated.spec ?? spec, userAddress);
    const estMaxFee = BigInt(estimated.maxFee || '0');
    const maxFeeBuffered = estMaxFee > BigInt(25_000) ? estMaxFee : BigInt(25_000);

    const burnIntentSpec = {
      maxBlockHeight: estimated.maxBlockHeight.toString(),
      maxFee: maxFeeBuffered.toString(),
      spec: cleanedSpec,
    };

    const eip712Domain = {
      name: 'GatewayWallet',
      version: '1',
    };

    const eip712Types = {
      BurnIntent: [
        { name: 'maxBlockHeight', type: 'uint256' },
        { name: 'maxFee', type: 'uint256' },
        { name: 'spec', type: 'TransferSpec' },
      ],
      TransferSpec: [
        { name: 'version', type: 'uint32' },
        { name: 'sourceDomain', type: 'uint32' },
        { name: 'destinationDomain', type: 'uint32' },
        { name: 'sourceContract', type: 'bytes32' },
        { name: 'destinationContract', type: 'bytes32' },
        { name: 'sourceToken', type: 'bytes32' },
        { name: 'destinationToken', type: 'bytes32' },
        { name: 'sourceDepositor', type: 'bytes32' },
        { name: 'destinationRecipient', type: 'bytes32' },
        { name: 'sourceSigner', type: 'bytes32' },
        { name: 'destinationCaller', type: 'bytes32' },
        { name: 'value', type: 'uint256' },
        { name: 'salt', type: 'bytes32' },
        { name: 'hookData', type: 'bytes' },
      ],
    };

    return NextResponse.json({
      burnIntentSpec,
      eip712Domain,
      eip712Types,
      fees: estimateData.fees,
    });
  } catch (err: unknown) {
    console.error('[gateway-withdraw] Estimate error:', err);
    const msg = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
