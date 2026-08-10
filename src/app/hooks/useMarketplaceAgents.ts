'use client';

import { useState, useEffect } from 'react';
import { createPublicClient, http, parseAbi, type Address } from 'viem';
import { Agent } from '../../types';

// ─── Chain & Client ─────────────────────────────────────────────────────────────

const _CHAIN_ID     = parseInt(process.env.NEXT_PUBLIC_CHAIN_ID ?? '5042002', 10);
const _RPC_URL      = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://rpc.testnet.arc.network';
const _PROXY_ADDR   = (process.env.NEXT_PUBLIC_MARKETPLACE_ADDRESS ?? '') as Address;

const _arcChain = {
  id: _CHAIN_ID,
  name: process.env.NEXT_PUBLIC_CHAIN_NAME ?? 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: { default: { http: [_RPC_URL] }, public: { http: [_RPC_URL] } },
} as const;

// Fast single attempt client - timeout 2.5s, no retries to prevent blocking UI
const _publicClient = createPublicClient({
  chain: _arcChain as any,
  transport: http(_RPC_URL, { timeout: 2500, retryCount: 0 }),
});

const _MARKETPLACE_ABI = parseAbi([
  'function marketRegistry(string) view returns (string agentId, address creator, address engineWallet, uint256 price, uint256 stakedAmount, uint256 recurringFeeBps, uint8 status, string metadataUri)',
]);

// ─── Default Preset Platform Agents ─────────────────────────────────────────────

const DEFAULT_PRESET_AGENTS: Agent[] = [
  {
    id: 'agent_smc_alpha_executor',
    name: 'SMC Alpha Executor',
    description: 'Autonomous BTC & token-pair trading agent using Smart Money Concepts analysis. Executes BTC/USDC/EURC swaps on Arc via Circle App Kit Swap - no human confirmation required per trade.',
    usdc_price: 15,
    rating: 4.9,
    review_count: 24,
    tags: ['Trading', 'SMC', 'BTC'],
    category: 'Trading',
    metadataUri: 'ipfs://preset-smc-alpha',
    destinationType: 'market_chart',
    network: 'arc',
  },
  {
    id: 'agent_risk_rebalancer',
    name: 'Risk-Adjusted Rebalancer',
    description: 'Continuously monitors portfolio allocation and autonomously rebalances toward target weights using real-time risk signals. Executes rebalancing trades via Arc StableFX within user-defined spend limits.',
    usdc_price: 10,
    rating: 4.8,
    review_count: 18,
    tags: ['DeFi', 'Rebalance', 'Risk'],
    category: 'DeFi',
    metadataUri: 'ipfs://preset-risk-rebalancer',
    destinationType: 'market_chart',
    network: 'arc',
  },
  {
    id: 'agent_crossdex_arb',
    name: 'Cross-DEX Arbitrageur',
    description: 'Detects and executes swap-based arbitrage opportunities across Arc-native liquidity pools. Operates fully autonomously within user-configured risk envelopes - no flash loans, pure spot arbitrage.',
    usdc_price: 25,
    rating: 4.9,
    review_count: 31,
    tags: ['Arbitrage', 'CrossDEX', 'Spot'],
    category: 'Arbitrage',
    metadataUri: 'ipfs://preset-crossdex-arb',
    destinationType: 'market_chart',
    network: 'arc',
  },
];

// ─── Fast Agent On-Chain Check ──────────────────────────────────────────────────

async function fetchOnChainAgent(agentId: string): Promise<Agent | null> {
  try {
    const entry = await _publicClient.readContract({
      address: _PROXY_ADDR,
      abi: _MARKETPLACE_ABI,
      functionName: 'marketRegistry',
      args: [agentId],
    }) as readonly [string, Address, Address, bigint, bigint, bigint, number, string];

    const [id, , , price, , , status, metadataUri] = entry;
    if (status !== 1 || id === '') return null;

    const preset = DEFAULT_PRESET_AGENTS.find(p => p.id === agentId);
    return {
      id: agentId,
      name: preset?.name || agentId,
      description: preset?.description || '',
      usdc_price: Number(price) / 1_000_000,
      rating: preset?.rating || 4.8,
      review_count: preset?.review_count || 0,
      tags: preset?.tags || ['General'],
      category: preset?.category || 'General',
      metadataUri,
      destinationType: 'market_chart',
      network: 'arc',
    };
  } catch {
    return null;
  }
}

// ─── Hook ──────────────────────────────────────────────────────────────────────

export function useMarketplaceAgents() {
  const [agents, setAgents] = useState<Agent[]>(DEFAULT_PRESET_AGENTS);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadOnChainStatus = async () => {
      if (!_PROXY_ADDR) return;
      try {
        // Fast parallel fetch for presets with 2s race timeout
        const timeoutPromise = new Promise<null>(r => setTimeout(() => r(null), 2000));
        
        const fetchPromise = Promise.all(
          DEFAULT_PRESET_AGENTS.map(p => fetchOnChainAgent(p.id))
        );

        const results = await Promise.race([fetchPromise, timeoutPromise]);
        
        if (cancelled || !results) return;

        const updated = DEFAULT_PRESET_AGENTS.map((preset, idx) => {
          const onChain = results[idx];
          return onChain ? { ...preset, usdc_price: onChain.usdc_price } : preset;
        });

        setAgents(updated);
      } catch {
        /* Keep preset agents fallback */
      }
    };

    void loadOnChainStatus();
    return () => { cancelled = true; };
  }, []);

  return { agents, isLoading };
}
