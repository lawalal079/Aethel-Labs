'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { createPublicClient, http, parseAbi, decodeFunctionData, getAddress, type Address } from 'viem';
import { User, Agent, ExecutionLog } from '../types';
import { CircleWalletProvider, useCircleWallet } from './components/providers/CircleWalletProvider';
import { dispatchTask } from '../services/engineClient';
import { useMarketplaceAgents } from './hooks/useMarketplaceAgents';

// ─── Chain & public client (read-only) ────────────────────────────────────────

const _CHAIN_ID = parseInt(process.env.NEXT_PUBLIC_CHAIN_ID ?? '5042002', 10);
const _RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://rpc.testnet.arc.network';
const _PROXY_ADDR = (process.env.NEXT_PUBLIC_MARKETPLACE_ADDRESS ?? '') as Address;
// Start scanning from the block the contract was deployed — not genesis.
// This avoids scanning millions of irrelevant blocks on every page load.
const _DEPLOY_BLOCK = BigInt(process.env.NEXT_PUBLIC_MARKETPLACE_DEPLOY_BLOCK ?? '0');

const _arcChain = {
  id: _CHAIN_ID,
  name: process.env.NEXT_PUBLIC_CHAIN_NAME ?? 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: { default: { http: [_RPC_URL] }, public: { http: [_RPC_URL] } },
} as const;

const _publicClient = createPublicClient({
  chain: _arcChain as any,
  transport: http(_RPC_URL, {
    timeout: 8_000,      // 8 s per request
    retryCount: 2,       // retry transient failures
    retryDelay: 500,
  }),
});

const _MARKETPLACE_ABI = parseAbi([
  // V2 events
  'event AgentListed(string indexed agentId, uint256 price, uint256 stakedAmount, string metadataUri, address indexed developer, address engineWallet)',
  // AgentApproved fires when admin approves a listing — this is the source of truth for display
  'event AgentApproved(string indexed agentId)',
  'event AgentPurchased(address indexed buyer, string indexed agentId, uint256 totalPaid)',
  // V2 marketRegistry returns the full AgentListing struct:
  // (agentId, creator, engineWallet, price, stakedAmount, recurringFeeBps, status, metadataUri)
  // status is a uint8 enum: 0=PendingApproval, 1=Approved, 2=Delisted, 3=Suspended
  'function marketRegistry(string) view returns (string agentId, address creator, address engineWallet, uint256 price, uint256 stakedAmount, uint256 recurringFeeBps, uint8 status, string metadataUri)',
]);

// ABI for decoding approveAgent calldata
const _APPROVE_ABI = parseAbi(['function approveAgent(string agentId)']);

// ─── XSS-safe sanitizer ───────────────────────────────────────────────────────

/**
 * Strips HTML tags, script payloads, javascript: URIs, and on* event handlers
 * from developer-supplied strings before rendering them in the UI.
 */
function sanitizeString(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw
    // Remove all HTML / XML tags
    .replace(/<[^>]*>/g, '')
    // Neutralise javascript: URIs (case-insensitive, with optional whitespace)
    .replace(/javascript\s*:/gi, 'blocked:')
    // Remove inline event handlers (onload=, onclick=, onerror= …)
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    // Collapse encoded angle brackets
    .replace(/&lt;/gi, '').replace(/&gt;/gi, '')
    // Trim excess whitespace
    .trim()
    // Hard cap at 512 chars to prevent UI flooding
    .slice(0, 512);
}

// ─── Context shape ─────────────────────────────────────────────────────────────

interface AppContextType {
  // ── App state ─────────────────────────────────────────────────────────────
  currentUser: User;
  setCurrentUser: React.Dispatch<React.SetStateAction<User>>;
  activeTab: 'marketplace' | 'my-agents' | 'workflows' | 'billing';
  setActiveTab: (tab: 'marketplace' | 'my-agents' | 'workflows' | 'billing') => void;
  agents: Agent[];
  agentsLoading: boolean;
  deployedAgentIds: string[];
  executionLogs: ExecutionLog[];
  deployAgent: (agentId: string) => Promise<boolean>;
  recordDeployment: (agentId: string, txHash?: string) => void;
  topUpBalance: (amount: number) => void;
  selectedAgentForDeploy: Agent | null;
  setSelectedAgentForDeploy: (agent: Agent | null) => void;
  runMission: (intent: string, agentType: string, txHash: string) => Promise<void>;
  missionStatus: 'Idle' | 'Running' | 'Success' | 'Failed';
  missionLogs: string[];
  missionResult: string | null;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;

  // ── Agent Daemon status & controls ─────────────────────────────────────────
  daemonStatus: DaemonStatusData | null;
  isDeployingDaemon: boolean;
  refreshDaemonStatus: () => Promise<void>;
  startDaemonForAgent: (agentId: string) => Promise<boolean>;
  stopDaemonForAgent: () => Promise<boolean>;

  // ── Wallet (read-only mirrors from wagmi via CircleWalletProvider) ─────────
  walletAddress: string | null;
  isConnected: boolean;
  usdcBalance: string;
  walletBalance: string;
  spendingBalance: string;
  tradingWalletAddress: string | null;
  tradingWalletBalance: string;
  isTradingWalletProvisioned: boolean;
  feeWalletAddress: string | null;
  feeWalletBalance: string;
  isFeeWalletProvisioned: boolean;
  refreshBalance: () => Promise<void>;
  refreshTradingWallet: () => Promise<void>;
  /** Re-runs the on-chain license check and updates deployedAgentIds immediately */
  refreshLicenses: () => Promise<void>;
}

// ─── Default data ──────────────────────────────────────────────────────────────

const defaultUser: User = {
  id: 'usr_01j7x',
  email: 'corporate.admin@aethellabs.com',
  wallet_type: 'CIRCLE',
  usdc_account_balance: 0.00,
};

const initialAgents: Agent[] = [];

const initialLogs: ExecutionLog[] = [];

// ─── Inner context (reads from wagmi via CircleWalletProvider) ─────────────────

const AppContext = createContext<AppContextType | undefined>(undefined);

export function getAgentConfig(agentId: string) {
  const configs: Record<string, { destinationType: 'market_chart' | 'block_explorer'; network: string }> = {
    agent_smc_alpha_executor: { destinationType: 'market_chart', network: 'arc' },
    agent_risk_rebalancer: { destinationType: 'market_chart', network: 'arc' },
    agent_crossdex_arb: { destinationType: 'market_chart', network: 'arc' },
  };
  return configs[agentId] || { destinationType: 'block_explorer', network: 'arc' };
}

export interface DaemonStatusData {
  running: boolean;
  userAddress?: string;
  userRefId?: string;
  tradingWalletAddress?: string;
  intervalSeconds?: number;
  startedAt?: number;
  cycleCount?: number;
  lastCycleAt?: number | null;
  uptimeSeconds?: number;
  agentId?: string;
}

function AppProviderInner({ children }: { children: React.ReactNode }) {
  const { walletAddress, isConnected, usdcBalance: onChainBalance, walletBalance, spendingBalance, refreshBalance, loginResult, tradingWalletAddress, tradingWalletBalance, isTradingWalletProvisioned, feeWalletAddress, feeWalletBalance, isFeeWalletProvisioned, refreshTradingWallet } = useCircleWallet();
  const activeUserIdentifier: string = walletAddress ?? 'anonymous';

  const [currentUser, setCurrentUser] = useState<User>(defaultUser);
  const [activeTab, setActiveTab] = useState<'marketplace' | 'my-agents' | 'workflows' | 'billing'>('marketplace');
  // deployedAgentIds: always starts empty — source of truth is the on-chain
  // checkLicenses useEffect below, which gates strictly on feeWalletAddress.
  // NEVER pre-load from a walletAddress-keyed cache; that was the User-Controlled
  // wallet's data and must have zero influence here.
  const [deployedAgentIds, setDeployedAgentIds] = useState<string[]>([]);
  const [executionLogs, setExecutionLogs] = useState<ExecutionLog[]>(initialLogs);
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatusData | null>(null);
  const [isDeployingDaemon, setIsDeployingDaemon] = useState<boolean>(false);


  // On login, purge any stale walletAddress-keyed localStorage caches so they
  // can never bleed into a future session.
  useEffect(() => {
    if (!walletAddress || typeof window === 'undefined') return;
    try {
      localStorage.removeItem(`aethel_deployed_agents_${walletAddress}`);
      localStorage.removeItem(`aethel_deployed_agents_${walletAddress.toLowerCase()}`);
      localStorage.removeItem(`aethel_licenses_${walletAddress.toLowerCase()}`);
    } catch { /* ignore */ }
  }, [walletAddress]);


  // ── Agent data — delegated entirely to useMarketplaceAgents ───────────────
  const { agents, isLoading: agentsLoading } = useMarketplaceAgents();

  // ── Engine Execution States ────────────────────────────────────────────────
  const [missionStatus, setMissionStatus] = useState<'Idle' | 'Running' | 'Success' | 'Failed'>('Idle');
  const [missionLogs, setMissionLogs] = useState<string[]>([]);
  const [missionResult, setMissionResult] = useState<string | null>(null);

  // ── Toast Notification States ──────────────────────────────────────────────
  const [toasts, setToasts] = useState<Array<{ id: string; message: string; type: 'success' | 'error' | 'info' }>>([]);

  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4500);
  }, []);

  // ── Load live on-chain user transaction logs ───────────────────────────────
  useEffect(() => {
    if (!walletAddress) {
      setExecutionLogs([]);
      return;
    }

    let cancelled = false;

    const formatBlockTimestamp = (timestampInSeconds: number) => {
      const date = new Date(timestampInSeconds * 1000);
      return date
        .toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })
        .replace(',', ' ·');
    };

    const fetchRealLogs = async () => {
      try {
        const currentAddress = walletAddress as Address;
        const CHUNK_SIZE = 9500n;

        // ── Priority gate ──────────────────────────────────────────────────────
        // Delay this scan so balance reads (fetchUsdcBalance + fetchGatewayBalance)
        // get their eth_call slots before the getLogs storm starts.
        // Arc testnet's RPC rate-limits concurrent requests across all call types;
        // without this delay the log scan exhausts the quota and fetchGatewayBalance
        // fails immediately, showing 0.00 even when funds are present.
        await new Promise(res => setTimeout(res, 5_000));
        if (cancelled) return;

        const latestBlock = await _publicClient.getBlockNumber();
        // Limit scan range to recent 10,000 blocks (~1 chunk) to prevent RPC rate-limits
        const scanStart = latestBlock > 10000n ? latestBlock - 10000n : 0n;

        /** Throttle helper — 250ms gap between getLogs chunks to stay within RPC rate limits */
        const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

        // 1. Fetch AgentPurchased logs — buyer is the Fee Wallet
        if (!feeWalletAddress) return;
        const buyerToMatch = feeWalletAddress as Address;
        const purchaseLogs: any[] = [];
        for (let chunkStart = scanStart; chunkStart <= latestBlock; chunkStart += CHUNK_SIZE) {
          const chunkEnd = chunkStart + CHUNK_SIZE - 1n < latestBlock ? chunkStart + CHUNK_SIZE - 1n : latestBlock;
          try {
            const chunk = await _publicClient.getLogs({
              address: _PROXY_ADDR,
              event: _MARKETPLACE_ABI[1] as any, // AgentPurchased
              args: { buyer: buyerToMatch },
              fromBlock: chunkStart,
              toBlock: chunkEnd,
            });
            purchaseLogs.push(...chunk);
          } catch (e) {
            console.warn('[context] purchase logs fetch failed for chunk:', chunkStart);
          }
          await sleep(250); // throttle between chunks
        }

        // 2. Fetch AgentListed logs for this user as developer
        const listingLogs: any[] = [];
        for (let chunkStart = scanStart; chunkStart <= latestBlock; chunkStart += CHUNK_SIZE) {
          const chunkEnd = chunkStart + CHUNK_SIZE - 1n < latestBlock ? chunkStart + CHUNK_SIZE - 1n : latestBlock;
          try {
            const chunk = await _publicClient.getLogs({
              address: _PROXY_ADDR,
              event: _MARKETPLACE_ABI[0] as any, // AgentListed
              args: { developer: currentAddress },
              fromBlock: chunkStart,
              toBlock: chunkEnd,
            });
            listingLogs.push(...chunk);
          } catch (e) {
            console.warn('[context] listing logs fetch failed for chunk:', chunkStart);
          }
          await sleep(250); // throttle between chunks
        }

        if (cancelled) return;

        // Group all logs by transaction hash to avoid duplicates and enrich each record
        const txMap = new Map<string, {
          hash: string;
          blockNumber: bigint;
          purchaseEvent?: any;
          listingEvent?: any;
          transfers: any[];
        }>();

        const getOrCreateTx = (log: any) => {
          const hash = log.transactionHash;
          if (!txMap.has(hash)) {
            txMap.set(hash, {
              hash,
              blockNumber: log.blockNumber,
              transfers: [],
            });
          }
          return txMap.get(hash)!;
        };

        for (const log of purchaseLogs) {
          getOrCreateTx(log).purchaseEvent = log;
        }
        for (const log of listingLogs) {
          getOrCreateTx(log).listingEvent = log;
        }

        // Now, resolve block timestamps for the unique transactions.
        const uniqueBlocks = Array.from(new Set(Array.from(txMap.values()).map(tx => tx.blockNumber)));
        const blockTimestamps: Record<string, number> = {};

        await Promise.all(
          uniqueBlocks.map(async (blockNum) => {
            try {
              const block = await _publicClient.getBlock({ blockNumber: blockNum });
              blockTimestamps[blockNum.toString()] = Number(block.timestamp);
            } catch (err) {
              console.warn('[context] Failed to fetch block timestamp for', blockNum, err);
            }
          })
        );

        if (cancelled) return;

        // Map grouped transactions to ExecutionLog structure
        const realLogs: ExecutionLog[] = [];
        const txList = Array.from(txMap.values());
        txList.sort((a, b) => Number(b.blockNumber - a.blockNumber));

        for (const tx of txList) {
          const timestampSec = blockTimestamps[tx.blockNumber.toString()] || Math.floor(Date.now() / 1000);
          const dateStr = formatBlockTimestamp(timestampSec);

          if (tx.purchaseEvent) {
            const args = tx.purchaseEvent.args;
            const agentId = args.agentId;
            const totalPaid = Number(args.totalPaid) / 1_000_000;

            const matchedAgent = agents.find(a => a.id === agentId);
            const agentName = matchedAgent ? matchedAgent.name : agentId;

            // Purchased event on-chain proves ownership — add to deployedAgentIds
            if (agentId) {
              setDeployedAgentIds(prev => prev.includes(agentId) ? prev : [...prev, agentId]);
            }

            realLogs.push({
              id: `tx_${tx.hash.slice(2, 10)}`,
              agent_id: agentId,
              agent_name: agentName,
              timestamp: dateStr,
              status: 'SUCCESS',
              tx_type: 'Deployment',
              cost_usdc: totalPaid,
              tx_hash: `${tx.hash.slice(0, 8)}...${tx.hash.slice(-4)}`,
            });
          } else if (tx.listingEvent) {
            const args = tx.listingEvent.args;
            const agentId = args.agentId;

            const matchedAgent = agents.find(a => a.id === agentId);
            const agentName = matchedAgent ? matchedAgent.name : agentId;

            realLogs.push({
              id: `tx_${tx.hash.slice(2, 10)}`,
              agent_id: agentId,
              agent_name: agentName,
              timestamp: dateStr,
              status: 'SUCCESS',
              tx_type: 'Listing',
              cost_usdc: 0.00,
              tx_hash: `${tx.hash.slice(0, 8)}...${tx.hash.slice(-4)}`,
            });
          } else {
            // Standalone USDC transfers (like direct transfers or funding/withdrawing if any)
            const seenLogIndices = new Set<number>();
            for (const transfer of tx.transfers) {
              const logIndex = transfer.logIndex ?? 0;
              if (seenLogIndices.has(logIndex)) continue;
              seenLogIndices.add(logIndex);

              const { from, to, value } = transfer.args;
              const transferVal = Number(value) / 1_000_000;
              const isOutgoing = from?.toLowerCase() === walletAddress?.toLowerCase();

              realLogs.push({
                id: `tx_${tx.hash.slice(2, 10)}_${logIndex}`,
                agent_id: 'usdc_transfer',
                agent_name: isOutgoing ? 'Compute Credit Deposit' : 'USDC Transfer In',
                timestamp: dateStr,
                status: 'SUCCESS',
                tx_type: isOutgoing ? 'Transfer Out' : 'Transfer In',
                cost_usdc: isOutgoing ? transferVal : -transferVal,
                tx_hash: `${tx.hash.slice(0, 8)}...${tx.hash.slice(-4)}`,
              });
            }
          }
        }

        if (!cancelled) {
          setExecutionLogs(realLogs);
        }
      } catch (err) {
        console.error('[context] Error fetching real on-chain logs:', err);
      }
    };

    void fetchRealLogs();

    // Listen to real-time events to append to the log list instantly
    const unwatchPurchases = _publicClient.watchContractEvent({
      address: _PROXY_ADDR,
      abi: parseAbi(['event AgentPurchased(address indexed buyer, string indexed agentId, uint256 totalPaid)']),
      eventName: 'AgentPurchased',
      onLogs: async (logs) => {
        for (const log of logs) {
          const { buyer, agentId, totalPaid } = (log as any).args;
          // Purchases come from the Fee Wallet address.
          if (!feeWalletAddress || buyer.toLowerCase() !== feeWalletAddress.toLowerCase()) continue;
          
          let blockTimestamp = Math.floor(Date.now() / 1000);
          try {
            const block = await _publicClient.getBlock({ blockNumber: log.blockNumber });
            blockTimestamp = Number(block.timestamp);
          } catch {}

          const matchedAgent = agents.find(a => a.id === agentId);
          const agentName = matchedAgent ? matchedAgent.name : agentId;

          const newEntry: ExecutionLog = {
            id: `tx_${log.transactionHash.slice(2, 10)}`,
            agent_id: agentId,
            agent_name: agentName,
            timestamp: formatBlockTimestamp(blockTimestamp),
            status: 'SUCCESS',
            tx_type: 'Deployment',
            cost_usdc: Number(totalPaid) / 1_000_000,
            tx_hash: `${log.transactionHash.slice(0, 8)}...${log.transactionHash.slice(-4)}`,
          };

          setExecutionLogs(prev => {
            if (prev.some(l => l.tx_hash === newEntry.tx_hash)) return prev;
            return [newEntry, ...prev];
          });
        }
      }
    });

    const unwatchListings = _publicClient.watchContractEvent({
      address: _PROXY_ADDR,
      abi: parseAbi(['event AgentListed(string indexed agentId, uint256 price, string metadataUri, address indexed developer)']),
      eventName: 'AgentListed',
      onLogs: async (logs) => {
        for (const log of logs) {
          const { developer, agentId } = (log as any).args;
          if (developer.toLowerCase() !== walletAddress.toLowerCase()) continue;
          
          let blockTimestamp = Math.floor(Date.now() / 1000);
          try {
            const block = await _publicClient.getBlock({ blockNumber: log.blockNumber });
            blockTimestamp = Number(block.timestamp);
          } catch {}

          const matchedAgent = agents.find(a => a.id === agentId);
          const agentName = matchedAgent ? matchedAgent.name : agentId;

          const newEntry: ExecutionLog = {
            id: `tx_${log.transactionHash.slice(2, 10)}`,
            agent_id: agentId,
            agent_name: agentName,
            timestamp: formatBlockTimestamp(blockTimestamp),
            status: 'SUCCESS',
            tx_type: 'Listing',
            cost_usdc: 0.00,
            tx_hash: `${log.transactionHash.slice(0, 8)}...${log.transactionHash.slice(-4)}`,
          };

          setExecutionLogs(prev => {
            if (prev.some(l => l.tx_hash === newEntry.tx_hash)) return prev;
            return [newEntry, ...prev];
          });
        }
      }
    });

    return () => {
      cancelled = true;
      unwatchPurchases();
      unwatchListings();
    };
  }, [walletAddress, feeWalletAddress, agents]);

  // ── Nanopayment Cycle Tracking (feeds Transaction Ledger & Consumption Rate) ─
  const lastTrackedCycleRef = useRef<number>(0);
  useEffect(() => {
    if (!walletAddress) return;
    const engineUrl = process.env.NEXT_PUBLIC_ENGINE_URL || 'http://localhost:4000';

    const pollNanopaymentCycles = async () => {
      try {
        const res = await fetch(`${engineUrl}/agents/status?userAddress=${encodeURIComponent(walletAddress)}`);
        if (!res.ok) return;
        const data = await res.json();
        const cycleCount = data?.cycleCount ?? 0;

        if (cycleCount > lastTrackedCycleRef.current && lastTrackedCycleRef.current > 0) {
          // Inject one nanopayment log for each new cycle since last poll
          const newCycles = cycleCount - lastTrackedCycleRef.current;
          const agentName = data?.agentId?.includes('smc') ? 'SMC Alpha Executor' : (data?.agentId || 'Autonomous Agent');
          const now = new Date();
          const tsStr = now
            .toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
            .replace(',', ' ·');

          const newLogs: ExecutionLog[] = [];
          for (let i = 0; i < newCycles; i++) {
            newLogs.push({
              id: `nano_${cycleCount - i}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              agent_id: data?.agentId || 'agent_smc_alpha_executor',
              agent_name: agentName,
              timestamp: tsStr,
              status: 'SUCCESS',
              tx_type: 'Nanopayment',
              cost_usdc: 0.0001,
            });
          }

          setExecutionLogs(prev => {
            // De-duplicate: only add logs we haven't seen yet
            const existingIds = new Set(prev.map(l => l.id));
            const fresh = newLogs.filter(l => !existingIds.has(l.id));
            return [...fresh, ...prev];
          });
        }

        lastTrackedCycleRef.current = cycleCount;
      } catch {
        // Silent — non-critical
      }
    };

    pollNanopaymentCycles();
    const timer = setInterval(pollNanopaymentCycles, 10_000); // Every 10s
    return () => clearInterval(timer);
  }, [walletAddress]);


  const [selectedAgentForDeploy, setSelectedAgentForDeploy] = useState<Agent | null>(null);

  // Sync live Fee Wallet balance into currentUser
  useEffect(() => {
    if (feeWalletBalance && feeWalletBalance !== '0.00') {
      const parsed = parseFloat(feeWalletBalance);
      if (!isNaN(parsed)) {
        setCurrentUser(prev => ({ ...prev, usdc_account_balance: parsed, wallet_type: 'CIRCLE' }));
      }
    } else {
      setCurrentUser(prev => ({ ...prev, usdc_account_balance: 0.00, wallet_type: 'CIRCLE' }));
    }
  }, [feeWalletBalance]);

  const displayUsdcBalance = feeWalletBalance
    ? parseFloat(feeWalletBalance).toFixed(2)
    : '0.00';



  // ── Hydrate deployedAgentIds from on-chain license state ────────────────────
  // 1. Load from localStorage instantly (zero-flicker on refresh)
  // 2. Verify on-chain in background — update cache only on success
  // 3. On RPC failure, keep cached IDs so bought agents remain visible

  // Stable ref updated by the useEffect below so refreshLicenses can call it imperatively.
  const checkLicensesRef = React.useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    // CRITICAL: MUST wait for feeWalletAddress to resolve — licenses are issued to Fee Wallet.
    // If feeWalletAddress is null (still loading), do NOT run checkLicenses with walletAddress fallback,
    // as querying userLicenses against the User-Controlled wallet returns false and overwrites cache with empty [].
    const targetWallet = feeWalletAddress || walletAddress;
    if (!targetWallet || !_PROXY_ADDR || agents.length === 0) return;
    let cancelled = false;

    // ── Instant cache hydration ──────────────────────────────────────────────
    const cacheKey = `aethel_licenses_${targetWallet.toLowerCase()}`;
    if (typeof window !== 'undefined') {
      try {
        const raw = localStorage.getItem(cacheKey);
        if (raw) {
          const cached: string[] = JSON.parse(raw);
          if (Array.isArray(cached) && cached.length > 0) {
            setDeployedAgentIds(prev => {
              const merged = [...prev];
              for (const id of cached) {
                if (!merged.includes(id)) merged.push(id);
              }
              return merged;
            });
          }
        }
      } catch { /* ignore */ }
    }

    const checkLicenses = async () => {
      const _LICENSE_ABI = [
        {
          name: 'userLicenses',
          type: 'function',
          stateMutability: 'view',
          inputs: [{ name: '', type: 'address' }, { name: '', type: 'string' }],
          outputs: [{ name: '', type: 'bool' }],
        },
      ] as const;

      const results = await Promise.allSettled(
        agents.map(async (agent) => {
          try {
            // Check Fee Wallet address
            let has = await _publicClient.readContract({
              address: _PROXY_ADDR,
              abi: _LICENSE_ABI,
              functionName: 'userLicenses',
              args: [targetWallet as Address, agent.id],
            }) as boolean;

            // Fallback: check User-Controlled wallet address if different
            if (!has && walletAddress && walletAddress !== targetWallet) {
              has = await _publicClient.readContract({
                address: _PROXY_ADDR,
                abi: _LICENSE_ABI,
                functionName: 'userLicenses',
                args: [walletAddress as Address, agent.id],
              }) as boolean;
            }

            return { agentId: agent.id, has };
          } catch {
            return { agentId: agent.id, has: false };
          }
        })
      );

      const licensed: string[] = [];
      let anySuccess = false;
      results.forEach(res => {
        if (res.status === 'fulfilled') {
          anySuccess = true;
          if (res.value.has) licensed.push(res.value.agentId);
        }
      });

      if (!cancelled && anySuccess) {
        // Strictly set deployedAgentIds state to match on-chain active licenses
        setDeployedAgentIds(licensed);
        // Persist fresh on-chain license array to localStorage
        if (typeof window !== 'undefined') {
          try {
            localStorage.setItem(cacheKey, JSON.stringify(licensed));
          } catch { /* ignore */ }
        }
      }

    };

    // Store a stable ref so refreshLicenses can call it imperatively
    checkLicensesRef.current = checkLicenses;

    void checkLicenses();
    return () => { cancelled = true; };
  }, [feeWalletAddress, walletAddress, agents]);



  // ── Imperative license refresh (callable from marketplace after purchase) ──
  const refreshLicenses = useCallback(async () => {
    if (checkLicensesRef.current) {
      await checkLicensesRef.current();
    }
  }, []);

  // ── Daemon Status Polling & Daemon Controls ────────────────────────────────
  const refreshDaemonStatus = useCallback(async () => {
    if (!walletAddress) {
      setDaemonStatus(null);
      return;
    }
    try {
      const res = await fetch(`/api/agents/deploy?userAddress=${encodeURIComponent(walletAddress)}`);
      if (!res.ok) return;
      const data: DaemonStatusData = await res.json();
      setDaemonStatus(data);
      if (data.running && data.agentId) {
        setDeployedAgentIds(prev => prev.includes(data.agentId!) ? prev : [...prev, data.agentId!]);
      }
    } catch (err) {
      console.warn('[context] refreshDaemonStatus failed:', err);
    }
  }, [walletAddress]);

  useEffect(() => {
    if (isConnected && walletAddress) {
      void refreshDaemonStatus();
      const interval = setInterval(() => void refreshDaemonStatus(), 10_000);
      return () => clearInterval(interval);
    } else {
      setDaemonStatus(null);
    }
  }, [isConnected, walletAddress, refreshDaemonStatus]);

  // ── Fetch Real Transaction Ledger ──────────────────────────────────────────
  const fetchTransactions = useCallback(async () => {
    const targetAddr = feeWalletAddress || walletAddress;
    try {
      const res = await fetch(`/api/agents/transactions?userAddress=${encodeURIComponent(targetAddr || '')}`);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.transactions)) {
        const mappedLogs: ExecutionLog[] = data.transactions.map((t: any) => ({
          id: t.id,
          agent_id: t.agentId || 'system',
          agent_name: (t.agentName || 'Agent Task').replace(/_/g, ' '),
          timestamp: t.timestamp || new Date().toISOString(),
          status: t.status || 'SUCCESS',
          tx_type: t.txType || 'Nanopayment',
          cost_usdc: t.amountUsdc || 0,
          tx_hash: t.txHash || t.id,
        }));
        setExecutionLogs(mappedLogs);
      }
    } catch (err) {
      console.warn('[context] fetchTransactions failed:', err);
    }
  }, [walletAddress, feeWalletAddress]);

  useEffect(() => {
    void fetchTransactions();
    const interval = setInterval(() => void fetchTransactions(), 15_000);
    return () => clearInterval(interval);
  }, [fetchTransactions]);

  const startDaemonForAgent = useCallback(async (agentId: string): Promise<boolean> => {
    if (!walletAddress || !loginResult?.userToken) {
      showToast('Wallet or Circle session not active.', 'error');
      return false;
    }
    setIsDeployingDaemon(true);
    try {
      const res = await fetch('/api/agents/deploy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${loginResult.userToken}`,
        },
        body: JSON.stringify({
          userAddress: walletAddress,
          // Pass Fee Wallet address so the Layer-1 license check targets the right address.
          // Licenses are now issued to the Fee Wallet (not the User-Controlled wallet).
          feeWalletAddress: feeWalletAddress ?? null,
          agentId,
          intervalSeconds: 60,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        const rawErr = data.error || 'Failed to start daemon';
        let cleanErr = rawErr;
        if (rawErr.includes('License verification') || rawErr.includes('userLicenses') || rawErr.includes('0x14dec') || rawErr.includes('Raw Call Arguments')) {
          cleanErr = 'License verification busy due to testnet RPC latency. Please retry in a moment.';
        }
        throw new Error(cleanErr);
      }
      setDeployedAgentIds(prev => prev.includes(agentId) ? prev : [...prev, agentId]);
      showToast('Agent daemon started successfully!', 'success');
      await refreshDaemonStatus();
      return true;
    } catch (err: any) {
      console.error('[context] startDaemonForAgent error:', err);
      const rawMsg = err?.message || 'Failed to start daemon';
      let cleanMsg = rawMsg;
      if (rawMsg.includes('0x14dec') || rawMsg.includes('Raw Call Arguments') || rawMsg.includes('userLicenses')) {
        cleanMsg = 'License check busy due to testnet RPC latency. Please retry in a moment.';
      }
      showToast(cleanMsg, 'error');
      return false;
    } finally {
      setIsDeployingDaemon(false);
    }
  }, [walletAddress, feeWalletAddress, loginResult, refreshDaemonStatus, showToast]);



  const stopDaemonForAgent = useCallback(async (): Promise<boolean> => {
    if (!walletAddress || !loginResult?.userToken) {
      showToast('Wallet or Circle session not active.', 'error');
      return false;
    }
    try {
      const res = await fetch('/api/agents/deploy', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${loginResult.userToken}`,
        },
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        throw new Error(data.error || 'Failed to stop daemon');
      }
      showToast('Agent daemon stopped.', 'info');
      await refreshDaemonStatus();
      return true;
    } catch (err: any) {
      console.error('[context] stopDaemonForAgent error:', err);
      showToast(err.message || 'Failed to stop daemon', 'error');
      return false;
    }
  }, [walletAddress, loginResult, refreshDaemonStatus, showToast]);



  const deployAgent = async (agentId: string): Promise<boolean> => {
    const targetAgent = agents.find(a => a.id === agentId);
    if (!targetAgent) return false;

    if (currentUser.usdc_account_balance < targetAgent.usdc_price) {
      alert('Insufficient USDC balance. Please top up your Gas Tank.');
      return false;
    }

    setCurrentUser(prev => ({
      ...prev,
      usdc_account_balance: parseFloat((prev.usdc_account_balance - targetAgent.usdc_price).toFixed(4)),
    }));

    const newLog: ExecutionLog = {
      id: `tx_${Math.random().toString(36).substr(2, 9)}`,
      agent_id: targetAgent.id,
      agent_name: targetAgent.name.replace(/\s+/g, '_'),
      timestamp: new Date()
        .toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
        .replace(',', ' ·'),
      status: 'SUCCESS',
      tx_type: 'Deployment',
      cost_usdc: targetAgent.usdc_price,
      tx_hash: '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join(''),  // 32-byte placeholder
    };

    setExecutionLogs(prev => [newLog, ...prev]);
    setDeployedAgentIds(prev => prev.includes(agentId) ? prev : [...prev, agentId]);
    return true;
  };

  /**
   * Records an on-chain confirmed deployment directly — skips the local
   * balance check because the transaction receipt already proves payment.
   * Called by marketplace.tsx after a successful purchaseAgent() tx.
   */
  const recordDeployment = (agentId: string, txHash?: string) => {
    const targetAgent = agents.find(a => a.id === agentId);
    if (!targetAgent) return;

    const newLog: ExecutionLog = {
      id: `tx_${Math.random().toString(36).substr(2, 9)}`,
      agent_id: targetAgent.id,
      agent_name: targetAgent.name.replace(/\s+/g, '_'),
      timestamp: new Date()
        .toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
        .replace(',', ' ·'),
      status: 'SUCCESS',
      tx_type: 'Deployment',
      cost_usdc: targetAgent.usdc_price,
      tx_hash: txHash ?? ('0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')),  // 32-byte placeholder
    };

    setExecutionLogs(prev => [newLog, ...prev]);
    setDeployedAgentIds(prev => prev.includes(agentId) ? prev : [...prev, agentId]);
  };

  const startPollingLogs = (txHash: string) => {
    const engineUrl = process.env.NEXT_PUBLIC_ENGINE_URL || 'http://localhost:4000';
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      if (attempts > 100) {
        clearInterval(interval);
        setMissionStatus('Failed');
        setMissionLogs(prev => [...prev, '[Client] Polling timed out. Engine did not return result.']);
        showToast('Engine execution polling timed out.', 'error');
        return;
      }

      try {
        const response = await fetch(`${engineUrl}/status?txHash=${txHash}`);
        if (!response.ok) {
          if (response.status === 500) {
            clearInterval(interval);
            setMissionStatus('Failed');
            setMissionLogs(prev => [...prev, '[Client] Fatal error: Engine encountered a 500 Internal Server Error.']);
            showToast('Engine returned 500 Internal Server Error.', 'error');
            return;
          }
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json() as {
          status: 'Running' | 'Success' | 'Failed';
          logs: string[];
          result?: string;
          error?: string;
        };

        if (data.logs) {
          setMissionLogs(data.logs);
        }

        if (data.status === 'Success') {
          clearInterval(interval);
          setMissionStatus('Success');
          setMissionResult(data.result ?? 'Success');
        } else if (data.status === 'Failed') {
          clearInterval(interval);
          setMissionStatus('Failed');
          setMissionResult(data.error ?? 'Execution failed');
          showToast(`Execution failed: ${data.error}`, 'error');
        }
      } catch (err) {
        console.warn('[context] Polling logs error:', err);
      }
    }, 1500);
  };

  const runMission = async (intent: string, agentType: string, txHash: string): Promise<void> => {
    // Deduct computational gas fee locally
    setCurrentUser(prev => ({
      ...prev,
      usdc_account_balance: parseFloat((prev.usdc_account_balance - 0.05).toFixed(4)),
    }));

    setMissionStatus('Running');
    setMissionLogs([`[Client] Dispatching intent task to engine for agent: ${agentType}...`]);
    setMissionResult(null);

    try {
      // Forward the live compound identity — resolves both Privy and Circle sessions
      const res = await dispatchTask(intent, agentType, txHash, walletAddress || undefined, activeUserIdentifier);
      
      if (res.success && res.status === 'dispatching') {
        setMissionLogs(prev => [...prev, `[Client] Payment verified successfully. Task is dispatching on-chain.`, `[Client] Starting live telemetry polling...`]);
        startPollingLogs(txHash);
      } else if (res.success) {
        setMissionStatus('Success');
        setMissionResult(res.result ?? 'Success');
        setMissionLogs(prev => [...prev, `[Client] Execution completed successfully.`]);
      } else {
        setMissionStatus('Failed');
        const errText = res.error || 'Unknown engine error';
        setMissionLogs(prev => [...prev, `[Client] Dispatch failed: ${errText}`]);
        showToast(errText, 'error');
      }
    } catch (err: any) {
      setMissionStatus('Failed');
      const errString = err.message || String(err);
      setMissionLogs(prev => [...prev, `[Client] Network error: ${errString}`]);
      showToast(`Network error: ${errString}`, 'error');
    }
  };

  const topUpBalance = (amount: number) => {
    setCurrentUser(prev => ({
      ...prev,
      usdc_account_balance: parseFloat((prev.usdc_account_balance + amount).toFixed(2)),
    }));
  };



  return (
    <AppContext.Provider
      value={{
        currentUser,
        setCurrentUser,
        activeTab,
        setActiveTab,
        agents,
        agentsLoading,
        deployedAgentIds,
        executionLogs,
        deployAgent,
        recordDeployment,
        topUpBalance,
        selectedAgentForDeploy,
        setSelectedAgentForDeploy,
        runMission,
        missionStatus,
        missionLogs,
        missionResult,
        showToast,
        walletAddress,
        isConnected,
        usdcBalance: displayUsdcBalance,
        walletBalance: isConnected ? walletBalance : currentUser.usdc_account_balance.toFixed(2),
        spendingBalance: isConnected ? spendingBalance : '0.00',
        tradingWalletAddress,
        tradingWalletBalance,
        isTradingWalletProvisioned,
        feeWalletAddress,
        feeWalletBalance,
        isFeeWalletProvisioned,
        refreshBalance,
        refreshTradingWallet,
        daemonStatus,
        isDeployingDaemon,
        refreshDaemonStatus,
        startDaemonForAgent,
        stopDaemonForAgent,
        refreshLicenses,
      }}
    >
      {children}

      {/* Modern Fixed Toast Notifications */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-3 pointer-events-none max-w-sm w-full">
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-start justify-between gap-3 px-4 py-3 rounded-lg shadow-xl border text-xs font-semibold backdrop-blur-md transition-all duration-300 transform translate-y-0 animate-fadeIn ${
              toast.type === 'error'
                ? 'bg-[#1a0e0e]/95 border-[#e05252]/20 text-[#ff8080]'
                : toast.type === 'success'
                ? 'bg-[#0e1a12]/95 border-[#52e070]/20 text-[#80ff9a]'
                : 'bg-[#0e121a]/95 border-[#529ae0]/20 text-[#80beff]'
            }`}
          >
            <div className="flex-1 select-none pr-2 leading-normal">
              {toast.message}
            </div>
            <button
              onClick={() => setToasts(prev => prev.filter(t => t.id !== toast.id))}
              className="text-[#8a8f98] hover:text-white font-bold font-mono text-[14px] leading-none select-none focus:outline-none cursor-pointer"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}

// ─── Public provider ───────────────────────────────────────────────────────────

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <CircleWalletProvider>
    <AppProviderInner>{children}</AppProviderInner>
  </CircleWalletProvider>
);

// ─── Hook ──────────────────────────────────────────────────────────────────────

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used within an AppProvider');
  return context;
};
