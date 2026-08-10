/**
 * listener.ts
 *
 * Æthel Engine — Escrow Payment Event Listener Daemon
 *
 * Listens live on-chain for the 'AgentPurchased' event on the Æthel Marketplace Proxy contract
 * on Arc Testnet. Uses getLogs polling instead of eth_newFilter because the
 * Arc Testnet RPC does not support filter subscriptions (eth_getFilterChanges).
 */

import { ethers } from 'ethers';
import 'dotenv/config';

// ── Configuration ─────────────────────────────────────────────────────────────

const RPC_URL          = process.env.RPC_URL ?? 'https://rpc.testnet.arc.network';
const CONTRACT_ADDRESS = process.env.MARKETPLACE_ADDRESS ?? '0xD3362dB9Afa0D9e0FA6Eb9909527BFb6693AAe53';
const POLL_INTERVAL_MS = 4_000; // poll every 4 seconds

if (!CONTRACT_ADDRESS) {
  console.error('[Error] MARKETPLACE_ADDRESS environment variable is not defined in .env');
  process.exit(1);
}

// Minimal ABI — only what we need for polling
const MARKETPLACE_ABI = [
  'event AgentPurchased(address indexed buyer, string indexed agentId, uint256 totalPaid)',
];

// ── Provisioning stub ─────────────────────────────────────────────────────────

async function verifyAndProvisionAgent(
  agentId: string,
  user: string,
  amount: bigint,
  txHash: string,
  blockNumber: number,
) {
  console.log(`\n[provision] ─── On-Chain Escrow Event ─────────────────────────────`);
  console.log(`[provision] Tx Hash   : ${txHash}`);
  console.log(`[provision] Block     : ${blockNumber}`);
  console.log(`[provision] Agent ID  : ${agentId}`);
  console.log(`[provision] User      : ${user}`);
  console.log(`[provision] Amount    : ${ethers.formatUnits(amount, 6)} USDC`);
  console.log(`[provision] Status    : Provisioning agent workflow…`);
  console.log(`[provision] ────────────────────────────────────────────────────────\n`);
  // TODO: insert your real provisioning logic here
}

// ── Main daemon ───────────────────────────────────────────────────────────────

async function startDaemon() {
  console.log(`[listener] Initializing Æthel Marketplace Listener Daemon…`);
  console.log(`[listener] RPC Provider : ${RPC_URL}`);
  console.log(`[listener] Contract     : ${CONTRACT_ADDRESS}`);
  console.log(`[listener] Mode         : getLogs polling (${POLL_INTERVAL_MS}ms interval)`);

  let isRunning = true;
  let lastBlock = 0n;

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = () => {
    console.log(`\n[listener] Shutting down…`);
    isRunning = false;
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);

  // ── Initial RPC connection ──────────────────────────────────────────────────
  let provider: ethers.JsonRpcProvider;
  let contract: ethers.Contract;
  let iface: ethers.Interface;

  const connect = async (): Promise<boolean> => {
    try {
      provider = new ethers.JsonRpcProvider(RPC_URL);
      contract = new ethers.Contract(CONTRACT_ADDRESS!, MARKETPLACE_ABI, provider);
      iface    = new ethers.Interface(MARKETPLACE_ABI);

      // Verify connection by fetching current block number
      const currentBlock = await provider.getBlockNumber();
      console.log(`[listener] ─── Marketplace Sync Successful ─────────────────────────`);
      console.log(`[listener] Current Block : ${currentBlock}`);
      console.log(`[listener] ─────────────────────────────────────────────────────────`);

      // Start polling from the current block
      lastBlock = BigInt(currentBlock);
      console.log(`[listener] Polling from block ${lastBlock}…\n`);
      return true;
    } catch (err) {
      console.error(`[listener] Connection failed:`, err);
      return false;
    }
  };

  // ── Polling loop ───────────────────────────────────────────────────────────
  const poll = async () => {
    if (!isRunning) return;

    try {
      const latestBlock = BigInt(await provider.getBlockNumber());

      if (latestBlock > lastBlock) {
        const fromBlock = lastBlock + 1n;

        const logs = await provider.getLogs({
          address: CONTRACT_ADDRESS!,
          fromBlock,
          toBlock: latestBlock,
          topics: [iface.getEvent('AgentPurchased')!.topicHash],
        });

        for (const log of logs) {
          try {
            const parsed = iface.parseLog(log);
            if (!parsed) continue;

            const { buyer, agentId, totalPaid } = parsed.args as unknown as {
              buyer: string;
              agentId: string;
              totalPaid: bigint;
            };

            await verifyAndProvisionAgent(
              agentId,
              buyer,
              totalPaid,
              log.transactionHash,
              log.blockNumber,
            );
          } catch (parseErr) {
            console.warn(`[listener] Could not parse log in block ${log.blockNumber}:`, parseErr);
          }
        }

        lastBlock = latestBlock;
      }
    } catch (pollErr: any) {
      const msg: string = pollErr?.message ?? String(pollErr);
      if (msg.includes('filter not found') || msg.includes('could not coalesce')) {
        console.warn(`[listener] RPC hiccup (filter/coalesce) — retrying next poll…`);
      } else {
        console.error(`[listener] Poll error:`, pollErr);
        console.warn(`[listener] Attempting reconnect in 5 s…`);
        await new Promise(r => setTimeout(r, 5_000));
        await connect();
      }
    }

    if (isRunning) {
      setTimeout(poll, POLL_INTERVAL_MS);
    }
  };

  // ── Boot ───────────────────────────────────────────────────────────────────
  let connected = await connect();
  while (!connected && isRunning) {
    console.warn(`[listener] Retrying connection in 5 s…`);
    await new Promise(r => setTimeout(r, 5_000));
    connected = await connect();
  }

  if (isRunning) {
    poll();
    console.log(`[listener] Listener active — watching for AgentPurchased events.\n`);
  }
}

startDaemon().catch((err) => {
  console.error('[listener] Fatal startup failure:', err);
  process.exit(1);
});
