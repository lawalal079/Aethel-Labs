'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { useApp } from './context';
import {
  Upload, CheckCircle, Gear, Coins, Star, ChartLine, FileText, Code,
  Translate, Image as ImageIcon, ShieldCheck, TrendUp,
} from '@phosphor-icons/react';
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseUnits,
  parseAbi,
  type Address,
  type Chain,
  encodeFunctionData,
} from 'viem';
import { useCircleWallet } from './components/providers/CircleWalletProvider';
import { Agent } from '../types';

// ─── Chain & Contract constants ────────────────────────────────────────────────

const CHAIN_ID = parseInt(process.env.NEXT_PUBLIC_CHAIN_ID ?? '5042002', 10);
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://rpc.testnet.arc.network';
const CHAIN_NAME = process.env.NEXT_PUBLIC_CHAIN_NAME ?? 'Arc Testnet';
const PROXY_ADDR = (process.env.NEXT_PUBLIC_MARKETPLACE_ADDRESS ?? '') as Address;
const USDC_ADDR = (process.env.NEXT_PUBLIC_USDC_ADDRESS ?? '') as Address;

const arcTestnet: Chain = {
  id: CHAIN_ID,
  name: CHAIN_NAME,
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: {
    default: { http: [RPC_URL] },
    public: { http: [RPC_URL] },
  },
};

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL) });

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

const MARKETPLACE_ABI = parseAbi([
  'function purchaseAgent(string calldata agentId) external',
  'function marketRegistry(string) view returns (string agentId, address creator, uint256 price, bool isListed, string metadataUri)',
]);

// ─── Display helpers ───────────────────────────────────────────────────────────

const getAgentIcon = (id: string, iconName?: string) => {
  // Resolve icon from on-chain metadata name first (populated by context.tsx from metadataUri JSON)
  switch (iconName) {
    case 'TrendingUp': return <TrendUp size={24} className="text-[#4E8981]" />;
    case 'TrendUp': return <TrendUp size={24} className="text-[#4E8981]" />;
    case 'ChartLine': return <ChartLine size={24} className="text-[#4E8981]" />;
    case 'FileText': return <FileText size={24} className="text-[#4E8981]" />;
    case 'Code': return <Code size={24} className="text-[#4E8981]" />;
    case 'Translate': return <Translate size={24} className="text-[#4E8981]" />;
    case 'Image': return <ImageIcon size={24} className="text-[#4E8981]" />;
    case 'ShieldCheck': return <ShieldCheck size={24} className="text-[#4E8981]" />;
    case 'Gear': return <Gear size={24} className="text-[#4E8981]" />;
  }
  // Fallback: legacy ID-based mapping for agents without metadata icons
  switch (id) {
    case 'agent_data_analysis': return <ChartLine size={24} className="text-[#4E8981]" />;
    case 'agent_content_writing': return <FileText size={24} className="text-[#4E8981]" />;
    case 'agent_python_coding': return <Code size={24} className="text-[#4E8981]" />;
    case 'agent_lang_translation': return <Translate size={24} className="text-[#4E8981]" />;
    case 'agent_image_gen': return <ImageIcon size={24} className="text-[#4E8981]" />;
    case 'agent_ai_moderation': return <ShieldCheck size={24} className="text-[#4E8981]" />;
    default: return <Gear size={24} className="text-[#4E8981]" />;
  }
};

const DISPLAY_MAP: Record<string, { name: string; desc: string; price: string; reviews: string; rating: number; reviewsBottom: string }> = {
  agent_smc_alpha_executor: {
    name: 'SMC Alpha Executor',
    desc: 'Autonomous BTC & token-pair trading agent using Smart Money Concepts analysis. Executes BTC/USDC/EURC swaps on Arc via Circle App Kit Swap - no human confirmation required per trade.',
    price: '15.00 USDC',
    reviews: '412 reviews',
    rating: 4.8,
    reviewsBottom: '412 reviews',
  },
  agent_risk_rebalancer: {
    name: 'Risk-Adjusted Rebalancer',
    desc: 'Continuously monitors portfolio allocation and autonomously rebalances toward target weights using real-time risk signals. Executes rebalancing trades via Arc StableFX within user-defined spend limits.',
    price: '12.00 USDC',
    reviews: '380 reviews',
    rating: 4.8,
    reviewsBottom: '380 reviews',
  },
  agent_crossdex_arb: {
    name: 'Cross-DEX Arbitrageur',
    desc: 'Detects and executes swap-based arbitrage opportunities across Arc-native liquidity pools. Operates fully autonomously within user-configured risk envelopes - no flash loans, pure spot arbitrage.',
    price: '18.00 USDC',
    reviews: '295 reviews',
    rating: 4.8,
    reviewsBottom: '295 reviews',
  },
  agent_data_analysis: { name: 'Data Analysis', desc: 'Monitor data', price: '3.000 USDC', reviews: '253 reviews', rating: 4.7, reviewsBottom: '276 reviews' },
  agent_content_writing: { name: 'Content Writing', desc: 'Analyze script writing', price: '4.50 USDC', reviews: '492 reviews', rating: 4.7, reviewsBottom: '492 reviews' },
  agent_python_coding: { name: 'Python Coding', desc: 'Analyze smart codes', price: '6.00 USDC', reviews: '312 reviews', rating: 4.66, reviewsBottom: '403 reviews' },
  agent_lang_translation: { name: 'Language Translation', desc: 'Speak and translate', price: '2.00 USDC', reviews: '189 reviews', rating: 4.7, reviewsBottom: '159 reviews' },
  agent_image_gen: { name: 'Image Generation', desc: 'Provide content', price: '5.00 USDC', reviews: '199 reviews', rating: 4.9, reviewsBottom: '256 reviews' },
  agent_ai_moderation: { name: 'AI Moderation', desc: 'Monitor breaches', price: '2.50 USDC', reviews: '330 reviews', rating: 4.53, reviewsBottom: '330 reviews' },
};

const d = (id: string, fallback: Agent) => {
  const mapped = DISPLAY_MAP[id];
  if (mapped) return mapped;

  // Fallback sanitizer — if name/desc starts with ipfs:// or raw URI, format cleanly
  let cleanName = fallback.name;
  if (!cleanName || cleanName.startsWith('ipfs://') || cleanName.startsWith('http')) {
    cleanName = id.replace(/^agent_/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  let cleanDesc = fallback.description;
  if (!cleanDesc || cleanDesc.startsWith('ipfs://')) {
    cleanDesc = `Autonomous AI agent for ${cleanName}.`;
  }

  return {
    name: cleanName,
    desc: cleanDesc,
    price: `${fallback.usdc_price.toFixed(2)} USDC`,
    reviews: `${fallback.review_count} reviews`,
    rating: fallback.rating,
    reviewsBottom: `${fallback.review_count} reviews`,
  };
};


// ─── USDC icon ─────────────────────────────────────────────────────────────────
const USDCIcon = ({ className = 'w-6 h-6' }: { className?: string }) => (
  <svg viewBox="0 0 32 32" className={`${className} flex-shrink-0`} fill="none" xmlns="http://www.w3.org/2000/svg">
    <g fill="white">
      <path d="M20.022 18.124c0-2.124-1.28-2.852-3.84-3.156-1.828-.243-2.193-.728-2.193-1.578 0-.85.61-1.396 1.828-1.396 1.097 0 1.707.364 2.011 1.275a.458.458 0 00.427.303h.975a.416.416 0 00.427-.425v-.06a3.04 3.04 0 00-2.743-2.489V9.142c0-.243-.183-.425-.487-.486h-.915c-.243 0-.426.182-.487.486v1.396c-1.829.242-2.986 1.456-2.986 2.974 0 2.002 1.218 2.791 3.778 3.095 1.707.303 2.255.668 2.255 1.639 0 .97-.853 1.638-2.011 1.638-1.585 0-2.133-.667-2.316-1.578-.06-.242-.244-.364-.427-.364h-1.036a.416.416 0 00-.426.425v.06c.243 1.518 1.219 2.61 3.23 2.914v1.457c0 .242.183.425.487.485h.915c.243 0 .426-.182.487-.485V21.34c1.829-.303 3.047-1.578 3.047-3.217z" />
      <path d="M12.892 24.497c-4.754-1.7-7.192-6.98-5.424-11.653.914-2.55 2.925-4.491 5.424-5.402.244-.121.365-.303.365-.607v-.85c0-.242-.121-.424-.365-.485-.061 0-.183 0-.244.06a10.895 10.895 0 00-7.13 13.717c1.096 3.4 3.717 6.01 7.13 7.102.244.121.488 0 .548-.243.061-.06.061-.122.061-.243v-.85c0-.182-.182-.424-.365-.546zm6.46-18.936c-.244-.122-.488 0-.548.242-.061.061-.061.122-.061.243v.85c0 .243.182.485.365.607 4.754 1.7 7.192 6.98 5.424 11.653-.914 2.55-2.925 4.491-5.424 5.402-.244.121-.365.303-.365.607v.85c0 .242.121.424.365.485.061 0 .183 0 .244-.06a10.895 10.895 0 007.13-13.717c-1.096-3.46-3.778-6.07-7.13-7.162z" />
    </g>
  </svg>
);

// ─── Micro-spinner ─────────────────────────────────────────────────────────────
const Spinner = ({ className = '' }: { className?: string }) => (
  <svg className={`animate-spin ${className}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width={13} height={13}>
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
  </svg>
);

// ─── Agent card state ──────────────────────────────────────────────────────────
type DeployPhase = 'idle' | 'step1' | 'step2' | 'success' | 'error';
interface CardState { phase: DeployPhase; error?: string }

// ─── Skeleton card ─────────────────────────────────────────────────────────────
const AgentCardSkeleton = () => (
  <div className="bg-[#1A1D20] border border-[#2A2F35] rounded-[16px] p-6 flex flex-col gap-4 min-h-[220px]">
    <div className="flex items-start gap-4">
      <div className="w-12 h-12 rounded-xl skeleton-pulse flex-shrink-0" />
      <div className="flex-1 space-y-2 pt-1">
        <div className="h-4 w-3/4 skeleton-pulse rounded" />
        <div className="h-3 w-1/2 skeleton-pulse rounded opacity-70" />
      </div>
    </div>
    <div className="flex justify-between">
      <div className="h-4 w-24 skeleton-pulse rounded" />
      <div className="h-3 w-16 skeleton-pulse rounded opacity-70" />
    </div>
    <div className="border-t border-[#2A2F35]" />
    <div className="flex justify-between items-center">
      <div className="flex gap-0.5">
        {[...Array(5)].map((_, i) => <div key={i} className="w-3.5 h-3.5 skeleton-pulse rounded-sm" />)}
      </div>
      <div className="h-3 w-16 skeleton-pulse rounded opacity-70" />
    </div>
    <div className="flex justify-end mt-auto">
      <div className="h-8 w-20 skeleton-pulse rounded-xl" />
    </div>
  </div>
);

// ─── Main component ────────────────────────────────────────────────────────────
export default function Marketplace() {
  const {
    agents, agentsLoading, deployAgent, recordDeployment, setSelectedAgentForDeploy, setActiveTab,
    usdcBalance, refreshBalance, isConnected, deployedAgentIds, startDaemonForAgent, refreshLicenses,
  } = useApp();

  const circle = useCircleWallet();
  const activeAddress: Address | null = circle.walletAddress as Address | null;

  // Per-card state
  const [cardStates, setCardStates] = useState<Record<string, CardState>>({});
  const [mounted, setMounted] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const isLoadingAgents = agentsLoading;

  // Ratings state
  const [ratingStats, setRatingStats] = useState<Record<string, { average: number; count: number; reviews?: any[] }>>({});
  const [ratingModalAgent, setRatingModalAgent] = useState<Agent | null>(null);
  const [selectedStars, setSelectedStars] = useState<number>(5);
  const [commentText, setCommentText] = useState<string>('');
  const [isSubmittingRating, setIsSubmittingRating] = useState(false);
  const [ratingMsg, setRatingMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchRatings = useCallback(async () => {
    try {
      const res = await fetch('/api/agents/rate');
      if (!res.ok) return;
      const data = await res.json();
      if (data.ratings) {
        setRatingStats(data.ratings);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    setMounted(true);
    void fetchRatings();
  }, [fetchRatings]);

  const handleRatingSubmit = async () => {
    if (!ratingModalAgent || !circle.feeWalletAddress) {
      setRatingMsg({ type: 'error', text: 'Fee Wallet address not active. Please connect wallet.' });
      return;
    }
    setIsSubmittingRating(true);
    setRatingMsg(null);

    try {
      const userToken = circle.loginResult?.userToken;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (userToken) {
        headers['Authorization'] = `Bearer ${userToken}`;
      }

      const res = await fetch('/api/agents/rate', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          agentId: ratingModalAgent.id,
          userAddress: circle.feeWalletAddress || activeAddress,
          rating: selectedStars,
          comment: commentText,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to submit rating');
      }

      setRatingMsg({ type: 'success', text: 'Rating submitted successfully!' });
      await fetchRatings();
      setTimeout(() => {
        setRatingModalAgent(null);
        setRatingMsg(null);
      }, 1500);
    } catch (err: any) {
      setRatingMsg({ type: 'error', text: err.message || 'Rating submission failed' });
    } finally {
      setIsSubmittingRating(false);
    }
  };

  const setCard = useCallback((id: string, state: CardState) =>
    setCardStates(prev => ({ ...prev, [id]: state })), []);

  // ── Core TX sender ──────────────────────────────────────────────────────────
  const sendTx = useCallback(async (data: `0x${string}`, to: Address): Promise<`0x${string}`> => {
    if (!activeAddress) throw new Error('No wallet connected');

    // Circle path
    const userToken = circle.loginResult?.userToken;
    const walletId = circle.circleWallets?.[0]?.id;
    if (!userToken || !walletId) throw new Error('Circle credentials not found');

    // Fetch pre-existing transactions to correlate by difference
    const preTxIds = new Set<string>();
    let hasPreTx = false;
    try {
      const preRes = await fetch('/api/endpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'listTransactions', userToken }),
      });
      const preJson = await preRes.json();
      if (preRes.ok && preJson.transactions) {
        preJson.transactions.forEach((t: any) => {
          if (t.id) preTxIds.add(t.id);
        });
        hasPreTx = true;
      }
    } catch (e) {
      console.warn('Failed to pre-fetch transactions list:', e);
    }

    const createdAfter = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10m lookback fallback for clock skew

    const res = await fetch('/api/endpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sendContractTransaction', userToken, walletId, contractAddress: to, callData: data }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? 'Circle tx failed');

    await circle.executeChallenge!(json.challengeId);

    // Poll for transaction by listing transactions
    let hash: string | null = null;
    const TERMINAL = new Set(['COMPLETE', 'FAILED', 'CANCELLED']);
    for (let i = 0; i < 45 && !hash; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const pr = await fetch('/api/endpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'listTransactions', userToken }),
      });
      const pj = await pr.json();
      if (pr.ok && pj.transactions) {
        const match = pj.transactions.find((t: any) => {
          if (t.walletId !== walletId) return false;
          if (hasPreTx) {
            return !preTxIds.has(t.id);
          }
          return new Date(t.createDate).getTime() >= new Date(createdAfter).getTime();
        });

        if (match) {
          if (match.txHash) {
            hash = match.txHash;
          } else if (TERMINAL.has(match.state) || TERMINAL.has(match.status)) {
            throw new Error(`Circle transaction execution failed: ${match.errorReason || match.state || match.status}`);
          }
        }
      }
    }
    if (!hash) throw new Error('Timed out waiting for transaction hash.');
    await publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}` });
    return hash as `0x${string}`;
  }, [activeAddress, circle]);

  // ── On-chain Deploy: calls ENGINE /agents/purchase (Fee Wallet, entity-secret signed) ──────
  // No browser executeChallenge pop-up — USDC.approve + purchaseAgent are
  // both executed server-side from the user's Developer-Controlled Fee Wallet.
  const handleDeploy = useCallback(async (agent: Agent) => {
    const phase = cardStates[agent.id]?.phase;
    if (phase === 'step1' || phase === 'step2' || phase === 'success') return;

    const userToken = circle.loginResult?.userToken;
    if (!userToken) {
      setCard(agent.id, { phase: 'error', error: 'Circle session not active. Please log in first.' });
      setTimeout(() => setCard(agent.id, { phase: 'idle' }), 5000);
      return;
    }

    try {
      // Step 1/2 — ENGINE approve (shown to user as progress)
      setCard(agent.id, { phase: 'step1' });

      const res = await fetch('/api/agents/purchase', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${userToken}`,
        },
        body: JSON.stringify({ agentId: agent.id }),
      });

      // Step 2/2 label while we await the response (approve already done by ENGINE)
      setCard(agent.id, { phase: 'step2' });

      const data = await res.json();
      if (!res.ok || data.success === false) {
        throw new Error(data.error || `Purchase failed (HTTP ${res.status})`);
      }

      const { txHash, alreadyOwned } = data as { txHash?: string; alreadyOwned?: boolean; feeWalletAddress?: string };

      // Record in local app state
      setSelectedAgentForDeploy(agent);
      recordDeployment(agent.id, txHash);

      // Start the daemon loop on ENGINE (runs for both new purchases and already-owned agents)
      const deployedOk = await startDaemonForAgent(agent.id);
      if (!deployedOk) {
        throw new Error('Daemon start was rejected by Engine.');
      }

      // Immediately re-run on-chain license check so deployedAgentIds
      // reflects the new purchase without requiring a page refresh.
      void refreshLicenses();

      setCard(agent.id, { phase: 'success' });
      setTimeout(() => { setCard(agent.id, { phase: 'idle' }); setActiveTab('my-agents'); }, 1600);
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : 'Unknown error';
      const clean = raw.split('\n')[0].replace(/execution reverted:?\s*/i, '').slice(0, 120);
      setCard(agent.id, { phase: 'error', error: `Deployment failed: ${clean || 'Transaction rejected.'}` });
      setTimeout(() => setCard(agent.id, { phase: 'idle' }), 5000);
    }
  }, [cardStates, circle, recordDeployment, refreshLicenses, setSelectedAgentForDeploy, setActiveTab, setCard, startDaemonForAgent]);


  // ── Render deploy button ─────────────────────────────────────────────────────
  const renderBtn = (agent: Agent) => {
    // Already purchased — button allows switching to Agent Portal to operate/manage
    if (deployedAgentIds.includes(agent.id)) {
      return (
        <button
          onClick={() => setActiveTab('my-agents')}
          className="flex flex-col items-center justify-center border border-[#4E8981]/40 px-5 py-2 rounded-xl text-xs font-semibold cursor-pointer text-[#4E8981] hover:bg-[#4E8981]/10 transition-colors min-w-[110px]"
        >
          <div className="flex items-center gap-1.5">
            <CheckCircle size={13} weight="fill" />
            <span>Agent Portal</span>
          </div>
        </button>
      );
    }

    const state = cardStates[agent.id] ?? { phase: 'idle' };

    type Cfg = { label: string; sub?: string; cls: string; disabled: boolean; icon?: React.ReactNode };
    const cfgs: Record<DeployPhase, Cfg> = {
      idle: {
        label: 'Deploy',
        cls: 'bg-[#4E8981]/10 border-[#4E8981]/40 hover:bg-[#4E8981]/20 text-[#4E8981]',
        disabled: false,
      },
      step1: {
        label: 'Step 1/2',
        sub: 'Approving USDC…',
        cls: 'bg-amber-900/20 border-amber-700/40 text-amber-400 cursor-not-allowed',
        disabled: true,
        icon: <Spinner className="text-amber-400" />,
      },
      step2: {
        label: 'Step 2/2',
        sub: 'Confirming Tx…',
        cls: 'bg-sky-900/20 border-sky-700/40 text-sky-400 cursor-not-allowed',
        disabled: true,
        icon: <Spinner className="text-sky-400" />,
      },
      success: {
        label: 'Success!',
        cls: 'bg-emerald-900/20 border-emerald-700/40 text-emerald-400 cursor-not-allowed',
        disabled: true,
        icon: <CheckCircle size={13} weight="fill" className="text-emerald-400" />,
      },
      error: {
        label: 'Retry',
        cls: 'bg-rose-900/20 border-rose-700/40 hover:bg-rose-900/30 text-rose-400',
        disabled: false,
      },
    };

    const cfg = cfgs[state.phase];

    return (
      <div className="flex flex-col items-end gap-1.5">
        <button
          onClick={() => handleDeploy(agent)}
          disabled={cfg.disabled}
          className={`flex flex-col items-center justify-center border px-5 py-2 rounded-xl text-xs font-semibold active:scale-95 transition-all shadow-md min-w-[110px] ${cfg.cls}`}
        >
          <div className="flex items-center gap-1.5">
            {cfg.icon}
            <span>{cfg.label}</span>
          </div>
          {cfg.sub && (
            <span className="text-[9px] opacity-70 font-normal mt-0.5 tracking-wide">{cfg.sub}</span>
          )}
        </button>

        {/* Generic error text */}
        {state.phase === 'error' && state.error && (
          <p className="text-[10px] text-rose-400 leading-snug text-right max-w-[180px] animate-fadeIn">
            {state.error}
          </p>
        )}
      </div>
    );
  };

  // ── Refresh balance ─────────────────────────────────────────────────────────
  const handleRefresh = async () => {
    setIsRefreshing(true);
    await refreshBalance();
    setTimeout(() => setIsRefreshing(false), 600);
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
        <div>
          <h1 className="text-[32px] font-bold text-white mb-2 font-sans tracking-tight">
            AI Agent Marketplace
          </h1>
          <p className="text-[#8a8f98] text-lg font-light">
            Deploy AI agents to perform digital tasks and earn USDC
          </p>
        </div>

        {/* Balance widget */}
        <div className="bg-[#1A1D20] border border-[#2A2F35] rounded-xl p-4 w-[280px] h-[92px] flex flex-col justify-between">
          <div className="flex justify-between items-center">
            <span className="text-[#8a8f98] text-sm font-medium">Account balance</span>
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="text-[#8a8f98] hover:text-white transition-colors cursor-pointer p-0.5 rounded-lg hover:bg-white/5 active:scale-95 flex items-center justify-center"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                className={isRefreshing ? 'animate-spin text-[#4E8981]' : ''}>
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
              </svg>
            </button>
          </div>
          <div className="flex items-center gap-3">
            <USDCIcon className="w-10 h-10" />
            <span className="text-2xl font-bold text-white tracking-tight">
              {usdcBalance} <span className="text-sm text-[#8a8f98] font-normal">USDC</span>
            </span>
          </div>
        </div>
      </div>

      {/* Process Banner */}
      <div className="w-full bg-[#1A1D20] rounded-xl py-3 px-6 flex items-center justify-between overflow-x-auto select-none border border-[#2A2F35]">
        <div className="flex items-center gap-4 flex-wrap w-full justify-between text-neutral-300 text-[13px] font-medium">
          <div className="flex items-center gap-2"><Upload size={16} weight="bold" className="text-[#4E8981]" /><span className="text-white">Agent Deployment</span></div>
          <span className="text-[#2A2F35] font-bold">&gt;</span>
          <div className="flex items-center gap-2"><CheckCircle size={16} weight="bold" className="text-[#8a8f98]" /><span>Task Assignment</span></div>
          <span className="text-[#2A2F35] font-bold">&gt;</span>
          <div className="flex items-center gap-2"><Gear size={16} weight="bold" className="text-[#8a8f98]" /><span>Autonomous Work</span></div>
          <span className="text-[#2A2F35] font-bold">&gt;</span>
          <div className="flex items-center gap-2"><Coins size={16} weight="bold" className="text-[#8a8f98]" /><span>Payment in USDC</span></div>
        </div>
      </div>

      {/* Agent grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pt-2">
        {isLoadingAgents
          ? [...Array(6)].map((_, i) => <AgentCardSkeleton key={i} />)
          : agents.map(agent => {
            const info = d(agent.id, agent);
            const rStat = ratingStats[agent.id];
            const hasRatings = rStat && rStat.count > 0;
            const avgRating = hasRatings ? rStat.average : 0;
            const countRating = hasRatings ? rStat.count : 0;
            const isLicensed = deployedAgentIds.includes(agent.id);

            return (
              <div
                key={agent.id}
                className="bg-[#1A1D20] border border-[#2A2F35] rounded-[16px] p-6 flex flex-col justify-between min-h-[240px] shadow-xl hover:border-[#4E8981]/50 hover:shadow-[0_0_20px_rgba(78,137,129,0.05)] transition-all duration-300 relative"
              >
                <div>
                  {/* Card header */}
                  <div className="flex items-start gap-4 mb-4">
                    <div className="w-12 h-12 rounded-xl bg-[#4E8981]/10 border border-[#4E8981]/20 flex items-center justify-center flex-shrink-0">
                      {getAgentIcon(agent.id, agent.tags[0])}
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-white leading-tight">{info.name}</h3>
                      <p className="text-xs text-[#8a8f98] mt-1">{info.desc}</p>
                    </div>
                  </div>

                  {/* Price & license badge */}
                  <div className="flex justify-between items-baseline mb-3">
                    <span className="text-sm font-bold text-[#4E8981]">{info.price}</span>
                    {isLicensed && (
                      <span className="text-[10px] font-bold text-emerald-400 bg-emerald-950/40 border border-emerald-800/40 px-2 py-0.5 rounded-full">
                        Licensed
                      </span>
                    )}
                  </div>

                  <hr className="border-[#2A2F35] mb-3" />

                  {/* Real Rating Display */}
                  <div className="flex items-center justify-between mb-4">
                    {hasRatings ? (
                      <div className="flex items-center gap-1.5">
                        <div className="flex gap-0.5">
                          {[...Array(5)].map((_, i) => (
                            <Star key={i} size={14} weight="fill"
                              className={i < Math.floor(avgRating) ? 'text-[#facc15]' : 'text-[#2A2F35]'} />
                          ))}
                        </div>
                        <span className="text-xs font-bold text-white">
                          {avgRating.toFixed(1)}
                        </span>
                        <span className="text-[10px] text-[#8a8f98]">
                          ({countRating} {countRating === 1 ? 'rating' : 'ratings'})
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-[#8a8f98] italic bg-[#0B0B0C] px-2.5 py-1 rounded-md border border-[#2A2F35]">
                        No ratings yet
                      </span>
                    )}

                    {isLicensed && (
                      <button
                        onClick={() => {
                          setRatingModalAgent(agent);
                          setRatingMsg(null);
                          const userAddrStr = (circle.feeWalletAddress || activeAddress || '').toLowerCase();
                          const existingReview = (rStat?.reviews ?? []).find(
                            (r: any) => r.userAddress.toLowerCase() === userAddrStr
                          );
                          if (existingReview) {
                            setSelectedStars(existingReview.rating);
                            setCommentText(existingReview.comment || '');
                          } else {
                            setSelectedStars(5);
                            setCommentText('');
                          }
                        }}
                        className="text-[10px] font-semibold text-[#4E8981] hover:underline cursor-pointer"
                      >
                        {(() => {
                          const userAddrStr = (circle.feeWalletAddress || activeAddress || '').toLowerCase();
                          const existing = (rStat?.reviews ?? []).find(
                            (r: any) => r.userAddress.toLowerCase() === userAddrStr
                          );
                          return existing ? `Edit Review (★ ${existing.rating})` : 'Rate Agent';
                        })()}
                      </button>
                    )}
                  </div>
                </div>

                {/* Deploy button — live on-chain flow */}
                <div className="flex justify-end">
                  {renderBtn(agent)}
                </div>
              </div>
            );
          })}
      </div>

      {/* Interactive Rating Modal for Licensed Users */}
      {ratingModalAgent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-[#131619] border border-[#23272C] rounded-2xl p-6 shadow-2xl w-full max-w-sm flex flex-col gap-4 relative">
            <div className="flex justify-between items-center border-b border-[#23272C] pb-3">
              <h3 className="font-semibold text-sm text-white tracking-wide">Rate {ratingModalAgent.name}</h3>
              <button onClick={() => setRatingModalAgent(null)} className="text-[#8a8f98] hover:text-white">✕</button>
            </div>
            <p className="text-xs text-[#8a8f98]">
              Select your rating for this agent (1 to 5 stars):
            </p>
            <div className="flex items-center justify-center gap-2 py-2">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  onClick={() => setSelectedStars(star)}
                  className="p-1 cursor-pointer transition-transform hover:scale-110"
                >
                  <Star size={28} weight="fill" className={star <= selectedStars ? 'text-[#facc15]' : 'text-[#2A2F35]'} />
                </button>
              ))}
            </div>
            <textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Optional short review or comment..."
              className="w-full bg-[#0B0B0C] border border-[#2A2F35] rounded-xl p-3 text-xs text-white outline-none focus:border-[#4E8981] resize-none h-20"
            />
            {ratingMsg && (
              <p className={`text-xs p-2 rounded-lg ${ratingMsg.type === 'success' ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-800/40' : 'bg-rose-950/40 text-rose-400 border border-rose-800/40'}`}>
                {ratingMsg.text}
              </p>
            )}
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setRatingModalAgent(null)}
                className="flex-1 py-2 border border-[#2A2F35] text-[#8a8f98] rounded-xl text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={handleRatingSubmit}
                disabled={isSubmittingRating}
                className="flex-1 py-2 border border-[#4E8981] bg-[#4E8981]/20 text-[#4E8981] hover:text-white rounded-xl text-xs font-semibold"
              >
                {isSubmittingRating ? 'Submitting...' : 'Submit Rating'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* No-wallet hint */}
      {mounted && !isConnected && !isLoadingAgents && (
        <p className="text-center text-xs text-[#8a8f98] pt-2">
          Connect a wallet (Google or External) to execute on-chain deployments.
        </p>
      )}
    </div>
  );
}
