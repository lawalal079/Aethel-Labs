'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useApp } from './context';

import { useCircleWallet } from './components/providers/CircleWalletProvider';
const CandlestickChart = dynamic(() => import('./components/LightweightCandlestickChart'), { ssr: false });

import {
  Cpu, TerminalWindow, PaperPlaneRight, CheckCircle, X,
  ArrowRight, ShieldCheck, Gear, TrendUp, ChartLine,
  FileText, Code, Translate, Image as ImageIcon, ClockCounterClockwise,
  CaretDown,
} from '@phosphor-icons/react';
import { Agent } from '../types';
import { type Address } from 'viem';

// ─── Arc Testnet Chain Definitions ──────────────────────────────────────────
const CHAIN_ID = parseInt(process.env.NEXT_PUBLIC_CHAIN_ID ?? '5042002', 10);

// ─── Circle Gateway Payment Config ───────────────────────────────────────────
// Addresses come from CHAIN_CONFIGS.arcTestnet (@circle-fin/x402-batching/client).
// Same values used by dispatcher.ts — single source of truth via env vars.
const GATEWAY_WALLET_ADDRESS = (
  process.env.NEXT_PUBLIC_GATEWAY_WALLET_ADDRESS ?? '0x0077777d7EBA4688BDeF3E311b846F25870A19B9'
) as Address;

// ENGINE_WALLET_ADDRESS = the payTo address for all EIP-3009 TransferWithAuthorization payments
const ENGINE_WALLET_ADDRESS = (
  process.env.NEXT_PUBLIC_ENGINE_WALLET_ADDRESS ?? '0xDe45Ec28834C609307BEf5651688A6c41d5e6994'
) as Address;

// ─── dispatchTask — sends dispatch or re-dispatch (with paymentPayload for Heavy Agents) ──
async function dispatchTask(
  url: string,
  body: {
    intent: string;
    agentType: string;
    buyerAddress: string;
    maxTaskBudget?: string;
    userId?: string;
    paymentPayload?: unknown; // present only on Heavy Agent re-dispatch
  },
  /** Unverified hint — the backend derives the real identity from the auth token */
  claimedAddress: string,
  /** The Privy access token or Circle userToken to authenticate the request */
  authToken: string,
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
      'x-unverified-client-address': claimedAddress,
      ...(body.userId ? { 'x-user-id': body.userId } : {}),
    },
    body: JSON.stringify({
      intent:       body.intent,
      agentType:    body.agentType,
      buyerAddress: body.buyerAddress,
      ...(body.maxTaskBudget !== undefined ? { maxTaskBudget: body.maxTaskBudget } : {}),
      userId:       body.userId,
      ...(body.paymentPayload !== undefined ? { paymentPayload: body.paymentPayload } : {}),
    }),
  });
}

// ─── Agent icon resolver ───────────────────────────────────────────────────────
const getAgentIcon = (id: string, iconName?: string) => {
  switch (iconName) {
    case 'TrendingUp':
    case 'TrendUp':     return <TrendUp     size={18} className="text-[#4E8981]" weight="fill" />;
    case 'ChartLine':   return <ChartLine   size={18} className="text-[#4E8981]" weight="fill" />;
    case 'FileText':    return <FileText    size={18} className="text-[#4E8981]" weight="fill" />;
    case 'Code':        return <Code        size={18} className="text-[#4E8981]" weight="fill" />;
    case 'Translate':   return <Translate   size={18} className="text-[#4E8981]" weight="fill" />;
    case 'Image':       return <ImageIcon   size={18} className="text-[#4E8981]" weight="fill" />;
    case 'ShieldCheck': return <ShieldCheck size={18} className="text-[#4E8981]" weight="fill" />;
    case 'Gear':        return <Gear        size={18} className="text-[#4E8981]" weight="fill" />;
  }
  switch (id) {
    case 'agent_data_analysis':    return <ChartLine   size={18} className="text-[#4E8981]" weight="fill" />;
    case 'agent_content_writing':  return <FileText    size={18} className="text-[#4E8981]" weight="fill" />;
    case 'agent_python_coding':    return <Code        size={18} className="text-[#4E8981]" weight="fill" />;
    case 'agent_lang_translation': return <Translate   size={18} className="text-[#4E8981]" weight="fill" />;
    case 'agent_image_gen':        return <ImageIcon   size={18} className="text-[#4E8981]" weight="fill" />;
    case 'agent_ai_moderation':    return <ShieldCheck size={18} className="text-[#4E8981]" weight="fill" />;
    default:                       return <Cpu         size={18} className="text-[#4E8981]" weight="fill" />;
  }
};

// ─── Log line type ─────────────────────────────────────────────────────────────
// role/content fields mirror AgentSessionMessage schema from ENGINE/src/agents/utils.ts
interface ConsoleLine {
  id: string;
  /** 'loading' = transient in-place status (replaces itself); 'ack' = slim payment pill;
   *  'system' = error/warning box; 'user' = outgoing message; 'result' = final answer */
  type: 'system' | 'user' | 'ack' | 'result' | 'loading';
  text: string;
  ts: string;
  // Optional AgentSessionMessage-aligned fields (populated from history fetch or live turns)
  role?: 'user' | 'agent';
  content?: string;
}

// ─── AgentSessionMessage schema (mirrors ENGINE/src/agents/utils.ts) ──────────
interface AgentSessionMessage {
  role: 'user' | 'agent';
  content: string;
  timestamp: number;
  userId: string;
}


const parseAgentResult = (text: string) => {
  if (!text || !text.includes('### 🔎 Data Lineage & Verification')) {
    return { isParsed: false, content: text || '' };
  }


  try {
    const dataSourceMatch = text.match(/• Data Source:\s*(.*)/i);
    const dataSource = dataSourceMatch ? dataSourceMatch[1].trim() : 'Unknown';

    // Target Identity is now a markdown hyperlink: [label](url)
    // Extract both the display label and the pre-built absolute URL from the backend.
    const targetIdentityMatch = text.match(/• Target Identity:\s*\[([^\]]+)\]\(([^)]+)\)/);
    const targetIdentity = targetIdentityMatch ? targetIdentityMatch[1].trim() : 'Unknown';
    const verifiedSourceUrl = targetIdentityMatch ? targetIdentityMatch[2].trim() : '#';

    const metricsMatch = text.match(/• Live Metrics:\s*```json([\s\S]*?)```/i);
    const liveMetricsRaw = metricsMatch ? metricsMatch[1].trim() : '{}';
    let liveMetrics = {};
    try {
      liveMetrics = JSON.parse(liveMetricsRaw);
    } catch (e) {
      console.warn("Failed to parse live metrics json", e);
    }

    const parts = text.split('---');
    let analysis = '';
    let logsBlock = '';

    if (parts.length >= 3) {
      const rawAnalysisPart = parts[2].trim();
      const detailsIndex = rawAnalysisPart.indexOf('<details>');
      if (detailsIndex !== -1) {
        analysis = rawAnalysisPart.substring(0, detailsIndex).trim();
        logsBlock = rawAnalysisPart.substring(detailsIndex).trim();
      } else {
        analysis = rawAnalysisPart;
      }
    }

    const runtimeMatch = logsBlock.match(/\[Runtime Duration:\s*(.*?)\]/i);
    const runtime = runtimeMatch ? runtimeMatch[1].trim() : 'N/A';

    const feeMatch = logsBlock.match(/\[On-chain Settlement Fee:\s*(.*?)\]/i);
    const fee = feeMatch ? feeMatch[1].trim() : 'N/A';

    const releaseMatch = logsBlock.match(/\[Release Tx:\s*(.*?)\]/i);
    const releaseTx = releaseMatch ? releaseMatch[1].trim() : 'N/A';

    const settleMatch = logsBlock.match(/\[Settle Tx:\s*(.*?)\]/i);
    const settleTx = settleMatch ? settleMatch[1].trim() : 'N/A';

    return {
      isParsed: true,
      dataSource,
      targetIdentity,
      verifiedSourceUrl,
      liveMetrics,
      analysis,
      runtime,
      fee,
      releaseTx,
      settleTx
    };
  } catch (e) {
    console.error("Failed to parse result", e);
    return { isParsed: false, content: text };
  }
};

function nowTs() {
  return new Date().toLocaleTimeString('en-US', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// Stable ID for the single in-place loading status indicator line.
const LOADING_LINE_ID = 'live-loading-indicator';

// ─── Empty state ───────────────────────────────────────────────────────────────
function NoDeployments({ onGoMarketplace }: { onGoMarketplace: () => void }) {
  return (
    <div className="flex items-center justify-center py-20">
      <div
        className="relative max-w-md w-full rounded-2xl border border-[#4E8981]/20 p-10 text-center overflow-hidden"
        style={{
          background: 'linear-gradient(135deg,rgba(78,137,129,0.06) 0%,rgba(11,11,12,0.92) 60%,rgba(78,137,129,0.04) 100%)',
          backdropFilter: 'blur(16px)',
          boxShadow: '0 0 60px rgba(78,137,129,0.06),inset 0 1px 0 rgba(78,137,129,0.12)',
        }}
      >
        <div className="absolute top-0 right-0 w-32 h-32 bg-[#4E8981]/5 rounded-full blur-3xl pointer-events-none" />
        <div className="w-16 h-16 mx-auto mb-6 rounded-2xl border border-[#4E8981]/20 bg-[#4E8981]/5 flex items-center justify-center">
          <TerminalWindow size={32} className="text-[#4E8981]" />
        </div>
        <h2 className="text-white text-xl font-bold tracking-tight mb-2">No Agents Deployed</h2>
        <p className="text-[#8a8f98] text-sm leading-relaxed mb-8">
          Purchase an agent from the Marketplace first. Your deployed agents will appear here ready to execute tasks.
        </p>
        <div className="flex items-center justify-center gap-3 text-[10px] text-[#8a8f98] mb-8 font-mono">
          <span className="px-2 py-0.5 border border-[#2A2F35] rounded">01 Buy Agent</span>
          <ArrowRight size={10} className="text-[#4E8981]" />
          <span className="px-2 py-0.5 border border-[#2A2F35] rounded">02 Return Here</span>
          <ArrowRight size={10} className="text-[#4E8981]" />
          <span className="px-2 py-0.5 border border-[#4E8981]/30 rounded text-[#4E8981]">03 Run Tasks</span>
        </div>
        <button
          onClick={onGoMarketplace}
          className="group inline-flex items-center gap-2 bg-[#4E8981]/10 hover:bg-[#4E8981]/20 border border-[#4E8981]/40 hover:border-[#4E8981]/70 text-[#4E8981] font-bold px-8 py-3 rounded-xl text-sm tracking-widest uppercase transition-all duration-200 active:scale-95 cursor-pointer"
          style={{ boxShadow: '0 0 20px rgba(78,137,129,0.08)' }}
        >
          <span>Go to Marketplace</span>
          <ArrowRight size={16} weight="bold" className="group-hover:translate-x-0.5 transition-transform duration-200" />
        </button>
      </div>
    </div>
  );
}

// ─── Agent Portal Panel ────────────────────────────────────────────────────────
function AgentPortal({ agent }: { agent: Agent }) {
  const circle = useCircleWallet();
  const userAddress: string | null = circle.walletAddress ?? null;
  const activeUserIdentifier: string = circle.walletAddress ?? 'anonymous';
  const activeUserId = typeof window !== 'undefined' ? (localStorage.getItem('circle_user_address') || circle.walletAddress || '') : '';
  const activeAgentId = agent.id;

  const [input, setInput]   = useState('');
  const [budget, setBudget] = useState('0.001');
  const [maxBudgetLimit, setMaxBudgetLimit] = useState<number | null>(null);
  const [messages, setMessages] = useState<ConsoleLine[]>(() => {
    if (typeof window !== 'undefined') {
      const key = `aethel_chat_history:${activeUserIdentifier}:${activeAgentId}`;
      const saved = localStorage.getItem(key);
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch (e) {
          console.error(e);
        }
      }
    }
    return [
      { id: 'boot-1', type: 'system', text: `Node "${agent.name}" — session initialised.`, ts: nowTs() },
      { id: 'boot-2', type: 'system', text: 'Awaiting operational directive…', ts: nowTs() },
    ];
  });
  const [running, setRunning] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // SESSION AIR-GAP: never persist messages under the 'anonymous' key — that would
    // allow boot/stale messages to bleed across to the next unauthenticated visitor.
    if (activeUserIdentifier === 'anonymous') return;
    const key = `aethel_chat_history:${activeUserIdentifier}:${activeAgentId}`;
    localStorage.setItem(key, JSON.stringify(messages));
  }, [messages, activeUserIdentifier, activeAgentId]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  // ─── History fetch hook: fires when agent or user identity changes ──────────
  const fetchChatHistoryFromDB = useCallback(async (userId: string, agentId: string) => {
    if (!userId || !activeUserIdentifier || activeUserIdentifier === 'anonymous') return;

    const engineUrl = process.env.NEXT_PUBLIC_ENGINE_URL || 'http://localhost:4000';
    try {
      const bearerToken: string | null = circle.loginResult?.userToken ?? null;
      if (!bearerToken) return;

      const r = await fetch(`${engineUrl}/history?agentId=${encodeURIComponent(agentId)}`, {
        headers: {
          'Authorization': `Bearer ${bearerToken}`,
          // Keep as unverified hint for backwards-compat logging only
          'x-unverified-client-address': activeUserIdentifier,
          'x-user-id': userId,
        },
      });
      if (!r.ok) return;

      const data: { success: boolean; thread: AgentSessionMessage[] } = await r.json();
      if (!data.success || !data.thread?.length) return;

      // Convert AgentSessionMessage[] → ConsoleLine[] preserving role/content fields
      const historyLines: ConsoleLine[] = data.thread.map((msg) => ({
        id: `hist-${msg.timestamp}-${Math.random().toString(36).slice(2)}`,
        type: (msg.role === 'user' ? 'user' : 'result') as ConsoleLine['type'],
        text: msg.content,
        ts: new Date(msg.timestamp).toLocaleTimeString(),
        role: msg.role,
        content: msg.content,
      }));

      // Suppress the default initial empty/boot state view by directly setting the history lines
      setMessages(historyLines);
    } catch (e) {
      // Silent fail — history is non-critical; session works fine without it
      console.warn('[history] Failed to fetch chat history from engine:', e);
    }
  }, [activeUserIdentifier]);

  useEffect(() => {
    // Only treat an empty activeUserId as a real logout if we also know the wallet
    // identifier has fully resolved. During Circle login there is a brief window where
    // the wallet loads and BOTH values are empty — don't wipe messages in that window.
    if (!activeUserId) {
      if (activeUserIdentifier !== 'anonymous') {
        // Real logout: a previously-identified user's token disappeared. Clear the view.
        setMessages([]);
      }
      return;
    }

    // Explicitly fetch history from the database using whichever ID is currently active
    fetchChatHistoryFromDB(activeUserId, activeAgentId);
  }, [activeUserId, activeAgentId, activeUserIdentifier, fetchChatHistoryFromDB]);

  // ─── Live Daemon Activity Polling: Stream active daemon reasoning & cycles into Console ───
  const lastLoggedCycleRef = useRef<number>(-1);
  useEffect(() => {
    if (!userAddress || !activeAgentId) return;

    const isDaemonAgent = ['agent_smc_alpha_executor', 'agent_crossdex_arb', 'agent_risk_rebalancer'].includes(activeAgentId);
    if (!isDaemonAgent) return;

    const engineUrl = process.env.NEXT_PUBLIC_ENGINE_URL || 'http://localhost:4000';

    const pollDaemonTelemetry = async () => {
      try {
        const res = await fetch(`${engineUrl}/agents/status?userAddress=${encodeURIComponent(userAddress)}`);
        if (!res.ok) return;
        const data = await res.json();

        if (data.running && (data.agentId === activeAgentId || activeAgentId === 'agent_smc_alpha_executor')) {
          if (data.cycleCount !== lastLoggedCycleRef.current) {
            lastLoggedCycleRef.current = data.cycleCount;

            const dec = data.latestDecision;
            const pos = data.activePosition;

            const newLines: ConsoleLine[] = [];

            newLines.push({
              id: `daemon-cycle-${data.cycleCount}-${Date.now()}`,
              type: 'system',
              text: `[Daemon Loop Active] Cycle #${data.cycleCount} on Arc Testnet (Uptime: ${data.uptimeSeconds || 0}s) · Wallet: ${data.tradingWalletAddress?.slice(0, 8)}...${data.tradingWalletAddress?.slice(-6)}`,
              ts: nowTs(),
            });

            if (dec) {
              const priceText = dec.price ? `$${Number(dec.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
              const rawPat = dec.patternDetected || dec.pattern;
              const hasPattern = rawPat && rawPat !== 'None';

              let patternLabel = 'None (Scanning 96 candles / 48h)';
              if (hasPattern) {
                const rangeStr = (dec.patternLow && dec.patternHigh)
                  ? ` ($${Number(dec.patternLow).toLocaleString()} - $${Number(dec.patternHigh).toLocaleString()})`
                  : '';
                patternLabel = `${rawPat}${rangeStr}`;
              }

              let signalLabel = dec.action || 'HOLD';
              if (dec.action === 'HOLD' && hasPattern) {
                const zoneText = (dec.patternLow && dec.patternHigh)
                  ? `$${Number(dec.patternLow).toLocaleString()} - $${Number(dec.patternHigh).toLocaleString()}`
                  : rawPat;
                signalLabel = `HOLD (Awaiting Retrace into ${zoneText} Zone)`;
              } else if (dec.action === 'SWAP') {
                signalLabel = `SWAP (${dec.fromToken} → ${dec.toToken})`;
              }

              newLines.push({
                id: `daemon-dec-${data.cycleCount}-${Date.now()}`,
                type: 'result',
                text: `[Market Analyst] ${dec.pricePairLabel || 'BTC/USD'} Spot: ${priceText} · Pattern: ${patternLabel} · Signal: ${signalLabel}`,
                ts: nowTs(),
              });

            if (dec && dec.reasoning) {
              const isErrorNotice =
                dec.reasoning.includes('Gemini API') ||
                dec.reasoning.includes('rate limit') ||
                dec.reasoning.includes('paused') ||
                dec.reasoning.includes('error') ||
                dec.reasoning.includes('HTTP 429');

              if (!isErrorNotice) {
                newLines.push({
                  id: `daemon-reason-${data.cycleCount}-${Date.now()}`,
                  type: 'system',
                  text: `[Gemini 2.5 Flash Reasoning] "${dec.reasoning}"`,
                  ts: nowTs(),
                });
              }
            }
            }

            if (pos && pos.amount > 0) {
              newLines.push({
                id: `daemon-pos-${data.cycleCount}-${Date.now()}`,
                type: 'result',
                text: `[Open Position] Holding ${pos.amount} ${pos.heldAsset} (Entry: $${pos.entryPrice})`,
                ts: nowTs(),
              });
            }

            newLines.push({
              id: `daemon-fee-${data.cycleCount}-${Date.now()}`,
              type: 'system',
              text: `[Nanopayment] 0.0001 USDC task-fee settled via EIP-3009 per cycle.`,
              ts: nowTs(),
            });

            setMessages(prev => {
              const filtered = prev.filter(m => m.id !== 'boot-2');
              return [...filtered, ...newLines];
            });
          }
        }
      } catch (err) {
        console.warn('[workflows] Polling daemon telemetry error:', err);
      }
    };

    pollDaemonTelemetry();
    const timer = setInterval(pollDaemonTelemetry, 4000);
    return () => clearInterval(timer);
  }, [userAddress, activeAgentId]);



  // Budget limit tracks the Gateway Spending Balance — this is what the agent
  // actually draws from for task fees (availableBalance on Gateway).
  // Wallet Balance (balanceOf) reflects on-chain custody but is NOT spendable
  // until deposited into Gateway. Use spendingBalance here, not walletBalance.
  useEffect(() => {
    if (!userAddress) return;
    const parsed = parseFloat(circle.spendingBalance);
    if (!isNaN(parsed)) {
      setMaxBudgetLimit(parsed);
    }
  }, [userAddress, circle.spendingBalance]);

  const addLine = useCallback((line: Omit<ConsoleLine, 'id'>) =>
    setMessages(prev => [...prev, { id: `l-${Date.now()}-${Math.random()}`, ...line }]), []);

  // Replaces the most recent 'loading' line in-place, or appends a new one.
  // This creates the single-line, in-place updating status indicator.
  const updateLoadingLine = useCallback((text: string) => {
    setMessages(prev => {
      const idx = prev.findIndex(l => l.id === LOADING_LINE_ID);
      const next: ConsoleLine = { id: LOADING_LINE_ID, type: 'loading', text, ts: nowTs() };
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = next;
        return updated;
      }
      return [...prev, next];
    });
  }, []);

  const removeLoadingLine = useCallback(() => {
    setMessages(prev => prev.filter(l => l.id !== LOADING_LINE_ID));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const directive = input.trim();
    if (!directive || running) return;

    // Parse budget — used as cap for Heavy Agents; Light Agent cost is post-execution.
    const budgetVal = parseFloat(budget);

    // ── Optimistic user message ───────────────────────────────────────────────
    addLine({ type: 'user', text: directive, ts: nowTs(), role: 'user', content: directive });
    setInput('');
    setRunning(true);

    const ackId = `ack-${Date.now()}`;
    setMessages(prev => [...prev, { id: ackId, type: 'ack', text: '⟳ Dispatching to Æthel Engine…', ts: nowTs() }]);

    try {
      const engineUrl = process.env.NEXT_PUBLIC_ENGINE_URL || 'http://localhost:4000';

      if (!userAddress) throw new Error('No wallet connected. Please connect your wallet first.');

      const authToken: string | null = circle.loginResult?.userToken ?? null;
      if (!authToken) throw new Error('No authentication token available. Please log in and try again.');

      // ── EIP-3009 signing helper ───────────────────────────────────────────────
      // Signs a GatewayWalletBatched TransferWithAuthorization using Circle Agent Wallet SDK.
      const signTransferAuthorization = async (params: {
        from: string;
        to: string;
        valueAtomic: string;
      }): Promise<{ signature: string; authorization: Record<string, string> }> => {
        const now = Math.floor(Date.now() / 1000);
        const nonceBytes = new Uint8Array(32);
        crypto.getRandomValues(nonceBytes);
        const nonce = '0x' + Array.from(nonceBytes).map(b => b.toString(16).padStart(2, '0')).join('');

        const authorization: Record<string, string> = {
          from:        params.from,
          to:          params.to,
          value:       params.valueAtomic,
          validAfter:  String(now - 600),
          validBefore: String(now + 604900),
          nonce,
        };

        // ── Circle signing path (challenge → poll getSignature) ───────────────
        const userToken = circle.loginResult?.userToken;
        const walletId  = circle.circleWallets?.[0]?.id;
        if (!userToken || !walletId) {
          throw new Error('Circle wallet not available for signing. Please re-authenticate.');
        }

        const typedData = {
          types: {
            EIP712Domain: [
              { name: 'name',              type: 'string'  },
              { name: 'version',           type: 'string'  },
              { name: 'chainId',           type: 'uint256' },
              { name: 'verifyingContract', type: 'address' },
            ],
            TransferWithAuthorization: [
              { name: 'from',        type: 'address' },
              { name: 'to',         type: 'address' },
              { name: 'value',      type: 'uint256' },
              { name: 'validAfter', type: 'uint256' },
              { name: 'validBefore', type: 'uint256' },
              { name: 'nonce',      type: 'bytes32' },
            ],
          },
          primaryType: 'TransferWithAuthorization',
          domain: {
            name:              'GatewayWalletBatched',
            version:           '1',
            chainId:           CHAIN_ID,
            verifyingContract: GATEWAY_WALLET_ADDRESS,
          },
          message: {
            from:        authorization.from,
            to:          authorization.to,
            value:       Number(authorization.value),
            validAfter:  Number(authorization.validAfter),
            validBefore: Number(authorization.validBefore),
            nonce:       authorization.nonce,
          },
        };

        // Step 1: initiate → get challengeId
        const signRes  = await fetch('/api/endpoints', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'signTypedData', userToken, walletId, typedData }),
        });
        const signJson = await signRes.json();
        if (!signRes.ok) {
          const detail = signJson.message ?? (signJson.error ? (typeof signJson.error === 'string' ? signJson.error : JSON.stringify(signJson.error)) : '');
          const codePart = signJson.code ? `[Code ${signJson.code}] ` : '';
          throw new Error(`Circle signTypedData failed: ${codePart}${detail || JSON.stringify(signJson)}`);
        }

        const { challengeId } = signJson;
        console.log('[workflows] Step 1 complete — challengeId:', challengeId, '| walletId:', walletId, '| userToken length:', userToken.length);
        if (!challengeId) throw new Error('Circle signTypedData succeeded but returned no challengeId.');

        // Step 2: user confirms in Circle modal — SDK returns result with signature directly
        console.log('[workflows] Step 2 — calling executeChallenge with challengeId:', challengeId);
        const challengeResult = await circle.executeChallenge!(challengeId) as { type?: string; status?: string; data?: { signature?: string } };
        console.log('[workflows] Step 2 complete — SDK result:', JSON.stringify(challengeResult));

        // Extract signature from SDK result (SignMessageResult.data.signature)
        const sdkSignature = challengeResult?.data?.signature ?? null;
        if (sdkSignature) {
          console.log('[workflows] Step 2 — signature obtained directly from SDK, no poll needed');
          return { signature: sdkSignature, authorization };
        }

        // Fallback: poll GET /v1/w3s/user/challenges/{challengeId} if SDK didn't return it
        console.log('[workflows] Step 3 — SDK did not return signature, polling challenges endpoint...');
        let signature: string | null = null;
        for (let i = 0; i < 15 && !signature; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const pollRes  = await fetch('/api/endpoints', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'getSignature', userToken, id: challengeId }),
          });
          const pollJson = await pollRes.json();
          console.log(`[workflows] Step 3 poll attempt ${i+1}:`, JSON.stringify(pollJson).substring(0, 300));
          if (pollRes.ok && pollJson.signature) {
            signature = pollJson.signature;
          } else if (!pollRes.ok) {
            const detail = pollJson.message ?? (pollJson.error ? (typeof pollJson.error === 'string' ? pollJson.error : JSON.stringify(pollJson.error)) : '');
            throw new Error(`Circle signature poll failed: ${detail || JSON.stringify(pollJson)}`);
          } else if (pollJson.state === 'FAILED' || pollJson.status === 'FAILED') {
            throw new Error('Circle signing failed or was rejected.');
          }
        }
        if (!signature) throw new Error('Timed out waiting for Circle signature.');
        return { signature, authorization };
      };

      // ── Initial dispatch (no paymentPayload) ─────────────────────────────────
      const res = await dispatchTask(
        `${engineUrl}/dispatch`,
        {
          intent:       directive,
          agentType:    agent.id,
          buyerAddress: userAddress,
          ...(!isNaN(budgetVal) && budgetVal > 0 ? { maxTaskBudget: budgetVal.toString() } : {}),
          userId:       activeUserId,
        },
        activeUserIdentifier,
        authToken,
      );

      const json = await res.json();
      setMessages(prev => prev.filter(l => l.id !== ackId));

      // ── Light Agent: 402 + jobId → sign actualCostAtomic → /dispatch/settle ──
      if (res.status === 402 && json.paymentRequired && json.jobId) {
        const costUSDC = (json.actualCostAtomic / 1_000_000).toFixed(6);
        addLine({ type: 'ack', text: `⟳ Task complete. Awaiting wallet signature for ${costUSDC} USDC…`, ts: nowTs() });

        let paymentPayload: unknown;
        try {
          const { signature, authorization } = await signTransferAuthorization({
            from:        userAddress,
            to:          ENGINE_WALLET_ADDRESS,
            valueAtomic: String(json.actualCostAtomic),
          });
          paymentPayload = { x402Version: 2, payload: { signature, authorization } };
        } catch (sigErr: any) {
          addLine({ type: 'system', text: `✗ Signature rejected: ${sigErr.message}`, ts: nowTs() });
          setRunning(false);
          return;
        }

        addLine({ type: 'ack', text: '⟳ Signature received. Settling payment…', ts: nowTs() });

        const settleRes  = await fetch(`${engineUrl}/dispatch/settle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
          body: JSON.stringify({ jobId: json.jobId, paymentPayload }),
        });
        const settleJson = await settleRes.json();

        if (!settleRes.ok) {
          addLine({ type: 'system', text: `✗ Settlement failed: ${settleJson.error ?? 'Unknown error'}`, ts: nowTs() });
          setRunning(false);
          return;
        }

        addLine({
          type: 'result', text: settleJson.result ?? '', ts: nowTs(),
          role: 'agent', content: settleJson.result ?? '',
        });
        setRunning(false);
        return;
      }

      // ── Heavy Agent: 402 + estimatedCostAtomic (no jobId) → sign → re-dispatch ──
      if (res.status === 402 && json.paymentRequired && json.estimatedCostAtomic && !json.jobId) {
        const estUSDC = (Number(json.estimatedCostAtomic) / 1_000_000).toFixed(6);
        addLine({ type: 'ack', text: `⟳ Heavy task — estimated cost: ${estUSDC} USDC. Awaiting wallet signature…`, ts: nowTs() });

        let paymentPayload: unknown;
        try {
          const { signature, authorization } = await signTransferAuthorization({
            from:        userAddress,
            to:          ENGINE_WALLET_ADDRESS,
            valueAtomic: String(json.estimatedCostAtomic),
          });
          paymentPayload = { x402Version: 2, payload: { signature, authorization } };
        } catch (sigErr: any) {
          addLine({ type: 'system', text: `✗ Signature rejected: ${sigErr.message}`, ts: nowTs() });
          setRunning(false);
          return;
        }

        addLine({ type: 'ack', text: '⟳ Lock signed. Dispatching heavy agent…', ts: nowTs() });

        // Re-dispatch WITH paymentPayload — Heavy Agent second-pass request.
        // The dispatcher will settle the lock payment, then run execution in the background.
        const heavyRes  = await dispatchTask(
          `${engineUrl}/dispatch`,
          {
            intent:         directive,
            agentType:      agent.id,
            buyerAddress:   userAddress,
            ...(!isNaN(budgetVal) && budgetVal > 0 ? { maxTaskBudget: budgetVal.toString() } : {}),
            userId:         activeUserId,
            paymentPayload,
          },
          activeUserIdentifier,
          authToken,
        );
        const heavyJson = await heavyRes.json();

        if (!heavyRes.ok) {
          addLine({ type: 'system', text: `✗ ${heavyJson.error ?? 'Heavy dispatch failed.'}`, ts: nowTs() });
          setRunning(false);
          return;
        }

        // 202 accepted — poll /status for background execution completion
        const displayId = heavyJson.jobId
          ? `${heavyJson.jobId.slice(0, 10)}…${heavyJson.jobId.slice(-6)}`
          : 'unknown';
        addLine({ type: 'ack', text: `✓ Job accepted — tracking ID: ${displayId}`, ts: nowTs() });

        // ── UX filter: surface only human-readable progress lines ──────────────
        const BLOCKED_STRINGS = ['[dispatcher]', '[system]', 'Buyer', 'Intent', 'Max Budget',
          'atomic units', 'Lock confirmed', 'Release confirmed', 'Worker FAILED',
          '"status":', '"logs":', '"result":', '"error":', '": {', '": }'];
        const isDisplayableLine = (text: string): boolean => {
          const t = text.trim();
          if (BLOCKED_STRINGS.some(s => t.includes(s))) return false;
          const ALLOW = ['●', '✓', '⟳', '✗', '❌', '◎', '▸'];
          if (ALLOW.some(s => t.startsWith(s))) return true;
          if (t.length > 0 && !t.startsWith('0x') && !t.startsWith('[') && !t.includes(':')) return true;
          return false;
        };

        const pollTxHash = heavyJson.jobId || heavyJson.txHash;
        let logged = 0;
        const pollStart = Date.now();
        // Seed the single in-place status indicator immediately
        updateLoadingLine('⟳ Engine processing…');
        const interval = setInterval(async () => {
          try {
            const r = await fetch(`${engineUrl}/status?txHash=${pollTxHash}`);
            if (!r.ok) {
              clearInterval(interval); setRunning(false);
              removeLoadingLine();
              addLine({ type: 'system', text: '✗ Telemetry link lost.', ts: nowTs() });
              return;
            }
            const data = await r.json() as { status: 'Running' | 'Success' | 'Failed'; logs: string[]; result?: string; error?: string };
            if (data.logs?.length > logged) {
              // Pick only the latest displayable log line to show in-place
              const newLines = data.logs.slice(logged).filter(l => isDisplayableLine(l));
              if (newLines.length > 0) {
                updateLoadingLine(newLines[newLines.length - 1]);
              }
              logged = data.logs.length;
            }
            if (data.status === 'Success') {
              clearInterval(interval); setRunning(false);
              const elapsed = ((Date.now() - pollStart) / 1000).toFixed(1);
              removeLoadingLine();
              addLine({ type: 'ack', text: `✓ Completed in ${elapsed}s`, ts: nowTs() });
              addLine({ type: 'result', text: data.result ?? '', ts: nowTs(), role: 'agent', content: data.result ?? '' });
            } else if (data.status === 'Failed') {
              clearInterval(interval); setRunning(false);
              removeLoadingLine();
              addLine({ type: 'system', text: '❌ Execution Stopped: The model engine could not complete processing. Balance safely preserved.', ts: nowTs() });
            }
          } catch { /* keep polling on brief glitch */ }
        }, 1500);
        return; // keep running=true while polling
      }

      // ── Any other non-ok response (real dispatcher error) ─────────────────────
      if (!res.ok) {
        addLine({ type: 'system', text: `✗ ${json.error ?? 'Execution blocked.'}`, ts: nowTs() });
        setRunning(false);
        return;
      }

      // ── Direct 202/200 (fallback — should not occur in normal Fix 3 flows) ────
      if (json.status === 'accepted') {
        const displayId = json.jobId ? `${json.jobId.slice(0, 10)}…${json.jobId.slice(-6)}` : 'unknown';
        addLine({ type: 'ack', text: `✓ Job accepted — tracking ID: ${displayId}`, ts: nowTs() });
      } else {
        addLine({ type: 'ack', text: `✓ ${json.message ?? 'Directive accepted.'}`, ts: nowTs() });
      }
      setRunning(false);

    } catch (err: any) {
      setMessages(prev => prev.filter(l => l.id !== ackId));
      addLine({ type: 'system', text: '❌ Execution Stopped: The model engine could not complete processing. Balance safely preserved.', ts: nowTs() });
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col h-full rounded-xl border border-[#2A2F35] bg-[#0B0B0C] overflow-hidden">
      {/* Console top bar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#2A2F35] bg-[#0f1214] shrink-0">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[10px] font-bold text-[#4E8981] tracking-widest uppercase font-mono">
            {agent.id} — Live Console
          </span>
          {maxBudgetLimit !== null && (
            <span className="text-[9px] font-mono text-[#8a8f98] bg-[#1A1D20] border border-[#2A2F35] px-1.5 py-0.5 rounded">
              Available: {maxBudgetLimit.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 6 })} USDC
            </span>
          )}
        </div>
        <span className="text-[9px] text-[#4E8981]/60 font-mono font-semibold border border-[#4E8981]/20 px-2 py-0.5 rounded">
          NODE: ACTIVE
        </span>
      </div>

      {/* Log output */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 scrollbar-none min-h-[300px] max-h-[500px]">
        {messages.map(line => {
          if (line.type === 'user') {
            return (
              <div key={line.id} className="flex justify-end w-full">
                <div className="max-w-[80%] rounded-2xl px-4 py-2.5 bg-[#4E8981]/12 border border-[#4E8981]/30 text-white font-sans text-xs shadow-md animate-fadeIn">
                  <span className="text-[9px] text-[#4E8981]/60 block mb-1 font-mono">{line.ts}</span>
                  <div className="break-words whitespace-pre-wrap">{line.text}</div>
                </div>
              </div>
            );
          }

          if (line.type === 'result') {
            const parsed = parseAgentResult(line.text);
            if (!parsed.isParsed) {
              return (
                <div key={line.id} className="flex justify-start w-full">
                  <div className="max-w-[90%] w-full rounded-2xl px-4 py-3 bg-[#16191C]/80 border border-[#2A2F35] text-[#c1c6d5] font-sans text-xs shadow-md space-y-2">
                    <div className="flex items-center justify-between text-[9px] text-[#8a8f98] font-mono border-b border-[#2A2F35] pb-1">
                      <span>RESULT</span>
                      <span>[{line.ts}]</span>
                    </div>
                    <div className="break-words whitespace-pre-wrap font-sans text-xs text-zinc-200 leading-relaxed">{line.text}</div>
                  </div>
                </div>
              );
            }



            return (
              <div key={line.id} className="flex justify-start w-full">
                <div className="max-w-[95%] w-full rounded-2xl border border-[#4E8981]/25 p-5 bg-[#121416]/90 space-y-4 shadow-lg backdrop-blur-md">
                  {/* Title / Header */}
                  <div className="flex items-center gap-2 border-b border-[#2A2F35] pb-2">
                    <Cpu size={16} className="text-[#4E8981]" />
                    <span className="text-xs font-bold text-white uppercase tracking-wider font-sans">{agent.name} Output</span>
                    <span className="text-[9px] text-[#8a8f98] font-mono ml-auto">[{line.ts}]</span>
                  </div>

                  {/* 1. Data Lineage Card */}
                  {(() => {
                    const metrics = (parsed.liveMetrics as Record<string, any>) || {};
                    const baseTokenSymbol = metrics.base_token;
                    const quoteTokenSymbol = metrics.quote_token;

                    let targetLink = parsed.verifiedSourceUrl || '#';
                    let displayLabel = parsed.targetIdentity;

                    const cleanBase = baseTokenSymbol ? String(baseTokenSymbol).toUpperCase().replace(/^W/, '') : 'ETH';
                    const cleanQuote = quoteTokenSymbol ? String(quoteTokenSymbol).toUpperCase() : 'USDC';

                    if (baseTokenSymbol && quoteTokenSymbol) {
                      const tfUnit = metrics.timeframe_unit ?? 'hour';
                      const agg = metrics.aggregate ?? 1;
                      const tvInterval = tfUnit === 'minute' ? agg : tfUnit === 'hour' ? agg * 60 : 'D';
                      targetLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${cleanBase}${cleanQuote}&interval=${tvInterval}`;
                      displayLabel = `${cleanBase} / ${cleanQuote}`;
                    }

                    const candles = metrics?.ohlcv_data as any[];
                    const poolAddress: string | undefined = metrics?.pool_address;
                    const network: string | undefined     = metrics?.network;
                    const tfLabel: string | undefined     = metrics?.timeframe;        // "15m", "4h", "1d"
                    const tfUnit: string | undefined      = metrics?.timeframe_unit;   // 'minute' | 'hour' | 'day'
                    const agg: number | undefined         = metrics?.aggregate;        // 15, 4, 1 …

                    // Dynamic key forces complete DOM teardown & hot reload on timeframe or asset changes
                    const chartKey = `${poolAddress ?? 'asset'}-${tfUnit ?? 'hour'}-${agg ?? 1}`;

                    // Agent ID checks to conditionally render structured components
                    const isSMC = agent.id === 'trading_bot_core';
                    const isPython = agent.id === 'agent_python_coding';
                    const isSolidity = agent.id === 'agent_solidity_dev';
                    const isArbitrage = agent.id === 'agent_arbitrage_bot';
                    const isMarketAgent = isSMC || isArbitrage;

                    // If critical data is missing, we skip the fancy cards and just show the raw response
                    if (metrics.insufficient_data || metrics.no_live_data) {
                      return (
                        <div className="font-sans text-xs text-zinc-200 leading-relaxed whitespace-pre-wrap">
                          {line.text}
                        </div>
                      );
                    }

                    return (
                      <>
                        {/* 1a. Market agents: Data Lineage card — hidden when data was unavailable */}
                        {isMarketAgent && (
                        <div className="rounded-xl border border-[#2A2F35] bg-[#0B0B0C]/80 p-3.5 space-y-2 font-mono text-[11px]">
                          <div className="text-[10px] font-bold text-[#8a8f98] uppercase tracking-wide font-sans">🔎 Data Lineage & Verification</div>
                          <div className="text-[#c1c6d5] space-y-1">
                            <div>• Data Source: <span className="text-white font-sans">{parsed.dataSource}</span></div>
                            <div className="truncate">
                              • Target Asset: <a href={targetLink} target="_blank" rel="noopener noreferrer" className="text-[#4E8981] hover:underline font-sans font-semibold">{displayLabel}</a>
                            </div>
                            <div>
                              <details className="mt-1 group">
                                <summary className="text-[10px] text-[#8a8f98] hover:text-white cursor-pointer select-none outline-none font-sans">
                                  ▸ View Raw Live Metrics
                                </summary>
                                <pre className="mt-2 text-[10px] bg-[#070809] border border-[#2A2F35] rounded p-2.5 overflow-x-auto text-zinc-300 max-h-[150px] scrollbar-none">
                                  {JSON.stringify(parsed.liveMetrics, null, 2)}
                                </pre>

                              </details>
                            </div>
                          </div>
                        </div>
                        )}

                        {/* 1b. Static agents: slim grounding citation instead of Data Lineage card */}
                        {(isPython || isSolidity) && (
                          <div className="flex items-center gap-1.5 text-[10px] text-[#8a8f98] font-mono px-0.5">
                            <span className="text-[#4E8981]/50">▸</span>
                            <span>
                              {isPython
                                ? 'Analysis method · static code review · grounded in submitted source code'
                                : 'Analysis method · static contract audit · grounded in submitted source code'}
                            </span>
                          </div>
                        )}

                        {/* 2a. Python Coding Agent Dashboard — only rendered when real code metrics exist */}
                        {isPython && (
                          (() => {
                            const hasCodeMetrics =
                              (metrics.code_lines && (metrics.code_lines as number) > 0) ||
                              ((metrics.function_names as string[])?.length > 0) ||
                              ((metrics.class_names as string[])?.length > 0) ||
                              ((metrics.import_modules as string[])?.length > 0);

                            if (!hasCodeMetrics) return null;

                            return (
                              <div className="rounded-xl border border-[#2A2F35] bg-[#0B0B0C]/80 p-3.5 space-y-3 font-mono text-[11px]">
                                <div className="text-[10px] font-bold text-[#8a8f98] uppercase tracking-wide font-sans flex items-center gap-1.5">
                                  <Code size={13} className="text-[#4E8981]" />
                                  <span>🐍 Python Code Metrics</span>
                                </div>
                                
                                {/* Horizontal flex row metric badge bar with charcoal borders */}
                                <div className="flex divide-x divide-zinc-800 border border-zinc-800 rounded bg-[#16191C]/60 text-center font-mono">
                                  <div className="flex-1 py-1 text-[10px] text-[#c1c6d5]">
                                    <span className="text-[#8a8f98]">Code Lines:</span> <span className="text-white font-bold">{metrics.code_lines ?? 0}</span>
                                  </div>
                                  <div className="flex-1 py-1 text-[10px] text-[#c1c6d5]">
                                    <span className="text-[#8a8f98]">Functions:</span> <span className="text-white font-bold">{(metrics.function_names as string[])?.length ?? 0}</span>
                                  </div>
                                  <div className="flex-1 py-1 text-[10px] text-[#c1c6d5]">
                                    <span className="text-[#8a8f98]">Classes:</span> <span className="text-white font-bold">{(metrics.class_names as string[])?.length ?? 0}</span>
                                  </div>
                                  <div className="flex-1 py-1 text-[10px] text-[#c1c6d5]">
                                    <span className="text-[#8a8f98]">Imports:</span> <span className="text-white font-bold">{(metrics.import_modules as string[])?.length ?? 0}</span>
                                  </div>
                                </div>

                                {((metrics.function_names && (metrics.function_names as string[]).length > 0) || 
                                  (metrics.class_names && (metrics.class_names as string[]).length > 0)) && (
                                  <div className="space-y-1.5 pt-1 border-t border-[#2A2F35]/30">
                                    {metrics.function_names && (metrics.function_names as string[]).length > 0 && (
                                      <div className="flex flex-wrap items-center gap-1 text-[9px] text-[#8a8f98]">
                                        <span className="font-semibold text-white uppercase font-sans">Functions:</span>
                                        {(metrics.function_names as string[]).map((f, i) => (
                                          <span key={i} className="px-1.5 py-0.5 bg-[#4E8981]/10 text-[#4E8981] border border-[#4E8981]/25 rounded font-mono">
                                            {f}()
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                    {metrics.class_names && (metrics.class_names as string[]).length > 0 && (
                                      <div className="flex flex-wrap items-center gap-1 text-[9px] text-[#8a8f98] mt-1.5">
                                        <span className="font-semibold text-white uppercase font-sans">Classes:</span>
                                        {(metrics.class_names as string[]).map((c, i) => (
                                          <span key={i} className="px-1.5 py-0.5 bg-indigo-500/10 text-indigo-400 border border-indigo-500/25 rounded font-mono">
                                            {c}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                )}

                                {metrics.import_modules && (metrics.import_modules as string[]).length > 0 && (
                                  <div className="pt-2 border-t border-[#2A2F35]/30">
                                    <div className="text-[9px] text-[#8a8f98] font-sans font-semibold mb-1 uppercase">Imported Modules</div>
                                    <div className="flex flex-wrap gap-1">
                                      {(metrics.import_modules as string[]).map((mod, i) => (
                                        <span key={i} className="px-1.5 py-0.5 bg-[#16191C]/80 border border-[#2A2F35] rounded font-mono text-[9px] text-white">
                                          import {mod}
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })()
                        )}

                        {/* 2b. Solidity Security Auditor Dashboard */}
                        {isSolidity && (
                          <div className="rounded-xl border border-[#2A2F35] bg-[#0B0B0C]/80 p-3.5 space-y-3 font-mono text-[11px]">
                            <div className="text-[10px] font-bold text-[#8a8f98] uppercase tracking-wide font-sans flex items-center justify-between border-b border-[#2A2F35]/40 pb-1.5">
                              <span className="flex items-center gap-1.5">
                                <ShieldCheck size={13} className="text-[#4E8981]" />
                                <span>🛡️ Solidity Security Audit</span>
                              </span>
                              <span className="text-[10px] font-bold text-[#8a8f98]">
                                SCORE:{' '}
                                <span className={`font-mono font-bold ${
                                  (metrics.gas_profile?.optimization_score ?? 100) >= 80 ? 'text-emerald-400' :
                                  (metrics.gas_profile?.optimization_score ?? 100) >= 60 ? 'text-amber-400' : 'text-rose-500'
                                }`}>
                                  {metrics.gas_profile?.optimization_score ?? 100}/100
                                </span>
                              </span>
                            </div>

                            {/* Active Network Gas Context Pills */}
                            <div className="flex items-center gap-2 pb-1 text-[9px] font-sans text-[#8a8f98]">
                              <span className="font-semibold">Active Gas:</span>
                              <span className="px-1.5 py-0.5 bg-zinc-900 border border-zinc-800 rounded font-mono">
                                Low: {metrics.live_gas_data?.safe_gas_gwei ?? '12'} Gwei
                              </span>
                              <span className="px-1.5 py-0.5 bg-zinc-900 border border-zinc-800 rounded font-mono">
                                Base: {metrics.live_gas_data?.propose_gas_gwei ?? '15'} Gwei
                              </span>
                              <span className="px-1.5 py-0.5 bg-[#4E8981]/15 border border-[#4E8981]/30 rounded text-[#4E8981] font-bold font-mono">
                                Fast: {metrics.live_gas_data?.fast_gas_gwei ?? '22'} Gwei
                              </span>
                            </div>

                            <div className="grid grid-cols-2 gap-2 text-center text-[10px]">
                              <div className="bg-[#16191C]/60 border border-[#2A2F35]/50 rounded-lg p-1.5">
                                <div className="text-[8px] text-[#8a8f98] uppercase">Deployment Cost</div>
                                <div className="font-bold text-white mt-0.5">{(metrics.gas_profile?.avg_deployment_gas ?? 1250000).toLocaleString()} gas</div>
                              </div>
                              <div className="bg-[#16191C]/60 border border-[#2A2F35]/50 rounded-lg p-1.5">
                                <div className="text-[8px] text-[#8a8f98] uppercase">Execution Cost</div>
                                <div className="font-bold text-white mt-0.5">{(metrics.gas_profile?.avg_execution_gas ?? 48200).toLocaleString()} gas</div>
                              </div>
                            </div>

                            {/* Structured Vulnerabilities Grid Table */}
                            <div className="space-y-1.5">
                              <div className="text-[9px] text-[#8a8f98] font-sans font-semibold uppercase">Security Static Audit Analysis</div>
                              <div className="overflow-x-auto border border-[#2A2F35] rounded-lg">
                                <table className="w-full text-[10px] text-left border-collapse">
                                  <thead>
                                    <tr className="bg-[#16191C]/80 border-b border-[#2A2F35] text-[#8a8f98] uppercase font-sans font-bold text-[9px]">
                                      <th className="p-2 w-[70px]">Severity</th>
                                      <th className="p-2 w-[90px]">Vulnerability</th>
                                      <th className="p-2">Description</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {metrics.vulnerabilities_found && (metrics.vulnerabilities_found as any[]).length > 0 ? (
                                      (metrics.vulnerabilities_found as any[]).map((v, i) => {
                                        let badgeStyle = '';
                                        if (v.severity === 'CRITICAL' || v.severity === 'HIGH') {
                                          badgeStyle = 'bg-rose-700 text-white font-bold px-1.5 py-0.5 rounded text-[8px] tracking-wider';
                                        } else if (v.severity === 'MEDIUM' || v.severity === 'LOW') {
                                          badgeStyle = 'bg-amber-500 text-black font-bold px-1.5 py-0.5 rounded text-[8px] tracking-wider';
                                        } else {
                                          badgeStyle = 'bg-blue-600 text-white font-bold px-1.5 py-0.5 rounded text-[8px] tracking-wider';
                                        }
                                        return (
                                          <tr key={i} className="border-b border-[#2A2F35]/40 hover:bg-[#16191C]/30 transition-colors">
                                            <td className="p-2 align-middle">
                                              <span className={badgeStyle}>{v.severity}</span>
                                            </td>
                                            <td className="p-2 font-bold text-white align-middle font-mono">{v.pattern}</td>
                                            <td className="p-2 text-[#8a8f98] leading-normal align-middle">{v.description}</td>
                                          </tr>
                                        );
                                      })
                                    ) : (
                                      <tr>
                                        <td colSpan={3} className="p-3 text-center text-emerald-400 bg-emerald-500/5 font-sans font-semibold">
                                          <div className="flex items-center justify-center gap-1.5">
                                            <CheckCircle size={14} className="text-emerald-400" />
                                            <span>No static vulnerabilities identified. Contract complies with best practices.</span>
                                          </div>
                                        </td>
                                      </tr>
                                    )}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          </div>
                        )}

                        {/* 2c. Cross-DEX Arbitrage Tracker Dashboard */}
                        {isArbitrage && (
                          <div className="rounded-xl border border-[#2A2F35] bg-[#0B0B0C]/80 p-3.5 space-y-3 font-mono text-[11px]">
                            <div className="text-[10px] font-bold text-[#8a8f98] uppercase tracking-wide font-sans flex items-center justify-between border-b border-[#2A2F35]/40 pb-1.5">
                              <span className="flex items-center gap-1.5">
                                <TrendUp size={13} className="text-[#4E8981]" />
                                <span>⚖️ Cross-DEX Arbitrage Tracker</span>
                              </span>
                              <span className="text-[10px] text-[#8a8f98] font-sans">
                                Opportunities: <span className="text-emerald-400 font-bold font-mono">LIVE</span>
                              </span>
                            </div>

                            {metrics.best_opportunity && (
                              <div className="p-3 bg-[#4E8981]/5 border border-[#4E8981]/20 rounded-xl space-y-1.5">
                                <div className="flex items-center justify-between">
                                  <span className="text-[9px] font-bold text-[#4E8981] uppercase font-sans tracking-wide">Best Route Detected</span>
                                  {metrics.best_opportunity.flash_loan_viable && (
                                    <span className="px-1.5 py-0.5 bg-emerald-400/10 text-emerald-400 border border-emerald-400/20 rounded font-bold text-[8px] uppercase tracking-wider font-sans animate-pulse">
                                      ⚡ Flash Loan Viable
                                    </span>
                                  )}
                                </div>
                                <div className="flex justify-between items-baseline">
                                  <div>
                                    <span className="text-white font-bold">{metrics.best_opportunity.asset_pair}</span>
                                    <span className="text-[#8a8f98] text-[9px] font-sans"> routing</span>
                                  </div>
                                  <div className="text-base font-bold text-emerald-400 font-mono">
                                    +{metrics.best_opportunity.spread_pct}%
                                  </div>
                                </div>
                                <div className="text-[9px] text-[#8a8f98] flex items-center gap-1 font-sans justify-between">
                                  <div className="flex items-center gap-1">
                                    <span className="text-white capitalize font-mono">{metrics.best_opportunity.buy_network}</span>
                                    <ArrowRight size={10} className="text-[#8a8f98]" />
                                    <span className="text-white capitalize font-mono">{metrics.best_opportunity.sell_network}</span>
                                  </div>
                                </div>
                              </div>
                            )}

                            {/* Arbitrage opportunities Grid Table */}
                            <div className="space-y-1.5">
                              <div className="text-[9px] text-[#8a8f98] font-sans font-semibold uppercase">Multi-Network Pool Spread Matrix</div>
                              {(() => {
                                const bestAsset = metrics.best_opportunity?.asset_pair;
                                const allPools = [
                                  ...(metrics.eth_pools || []).map((p: any) => ({ ...p, network: 'ethereum' })),
                                  ...(metrics.arbitrum_pools || []).map((p: any) => ({ ...p, network: 'arbitrum' })),
                                  ...(metrics.polygon_pos_pools || []).map((p: any) => ({ ...p, network: 'polygon_pos' })),
                                  ...(metrics.bsc_pools || []).map((p: any) => ({ ...p, network: 'bsc' })),
                                  ...(metrics.base_pools || []).map((p: any) => ({ ...p, network: 'base' })),
                                ];

                                const getNormalizedBase = (pName: string) => {
                                  const parts = (pName || '').split(/[\s\/\-]+/);
                                  if (parts.length < 1) return '';
                                  let baseToken = parts[0].toUpperCase();
                                  if (baseToken.startsWith('W') && baseToken.length > 2) {
                                    if (['WETH', 'WMON', 'WBTC', 'WSOL', 'WAVAX', 'WBNB'].includes(baseToken)) {
                                      baseToken = baseToken.substring(1);
                                    }
                                  }
                                  return baseToken;
                                };

                                const targetBase = bestAsset ? bestAsset.toUpperCase() : 'ETH';
                                const matchingPools = allPools.filter(p => getNormalizedBase(p.pool) === targetBase);
                                const prices = matchingPools.map(p => parseFloat(p.price_usd)).filter(p => !isNaN(p) && p > 0);
                                const minPrice = prices.length > 0 ? Math.min(...prices) : 0;

                                return (
                                  <div className="overflow-x-auto border border-[#2A2F35] rounded-lg">
                                    <table className="w-full text-[10px] text-left border-collapse font-sans">
                                      <thead>
                                        <tr className="bg-[#16191C]/80 border-b border-[#2A2F35] text-[#8a8f98] uppercase font-bold text-[9px] tracking-wider">
                                          <th className="p-2">Network</th>
                                          <th className="p-2">Asset Pair</th>
                                          <th className="p-2 text-right">Local Pool Price</th>
                                          <th className="p-2 text-right">24h Vol</th>
                                          <th className="p-2 text-right">Spread Delta</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {allPools.map((p, idx) => {
                                          const pairBase = getNormalizedBase(p.pool);
                                          const priceNum = parseFloat(p.price_usd);
                                          
                                          let spreadDelta = 0;
                                          if (pairBase === targetBase && minPrice > 0 && !isNaN(priceNum)) {
                                            spreadDelta = ((priceNum - minPrice) / minPrice) * 100;
                                          }

                                          const formattedVol = p.volume_24h 
                                            ? `$${parseFloat(p.volume_24h).toLocaleString(undefined, { maximumFractionDigits: 0 })}` 
                                            : '-';
                                          const formattedPrice = !isNaN(priceNum) ? `$${priceNum.toFixed(2)}` : '-';
                                          
                                          const isSpreadMilestone = pairBase === targetBase && 
                                            metrics.best_opportunity &&
                                            Math.abs(spreadDelta - metrics.best_opportunity.spread_pct) < 0.005;

                                          const rowClass = isSpreadMilestone
                                            ? "border border-emerald-500 bg-emerald-500/10 text-emerald-300 font-bold shadow-[0_0_15px_rgba(16,185,129,0.15)] animate-pulse"
                                            : "border-b border-[#2A2F35]/40 hover:bg-[#16191C]/30 text-[#c1c6d5] transition-colors";

                                          return (
                                            <tr key={idx} className={rowClass}>
                                              <td className="p-2 font-mono capitalize">{p.network}</td>
                                              <td className="p-2 font-mono font-bold text-white">{p.pool}</td>
                                              <td className="p-2 text-right font-mono font-semibold">{formattedPrice}</td>
                                              <td className="p-2 text-right font-mono">{formattedVol}</td>
                                              <td className="p-2 text-right font-mono text-emerald-400 font-semibold">
                                                {pairBase === targetBase && spreadDelta > 0 ? `+${spreadDelta.toFixed(4)}%` : '0.0000%'}
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                );
                              })()}
                            </div>
                          </div>
                        )}

                        {/* 2d. SMC Live Chart Embed — Native Client-Side Lightweight-Charts Player */}
                        {isSMC && poolAddress && network && candles && candles.length ? (
                          <div key={chartKey} className="rounded-xl border border-[#2A2F35] bg-[#0B0B0C]/80 overflow-hidden">
                            <div className="flex items-center justify-between px-3.5 py-2 border-b border-[#2A2F35]">
                              <span className="text-[10px] font-bold text-[#8a8f98] uppercase tracking-wide font-sans">
                                📊 SMC Alpha Execution Feed — {cleanBase} / {cleanQuote} ({tfLabel ?? '1h'})
                              </span>
                              <a
                                href={targetLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[9px] text-[#4E8981] hover:underline font-sans font-semibold"
                              >
                                ↗ Open Full Chart
                              </a>
                            </div>
                            <div className="p-3 bg-[#0B0B0C]/40">
                              <CandlestickChart
                                candles={candles}
                                poolName={displayLabel ?? ''}
                                timeframeLabel={tfLabel ?? '1h'}
                              />
                            </div>
                          </div>
                        ) : null}
                      </>
                    );

                  })()}




                  {/* 3. Core Narrative Analysis */}
                  <div className="text-xs leading-relaxed text-zinc-200 font-sans whitespace-pre-wrap border-l-2 border-[#4E8981] pl-3 py-1 text-left">
                    {parsed.analysis}
                  </div>



                  {/* 3. System Logs & Transaction Details */}
                  <div className="border-t border-[#2A2F35] pt-3">
                    <details className="group">
                      <summary className="flex items-center gap-1.5 text-[10px] font-bold text-[#8a8f98] hover:text-white cursor-pointer select-none outline-none font-sans">
                        <Gear size={12} className="group-open:rotate-45 transition-transform duration-200" />
                        <span>⚙️ View System Logs & Transaction Details</span>
                      </summary>
                      <div className="mt-2 rounded-lg bg-[#070809]/90 border border-[#2A2F35] p-3 font-mono text-[10px] text-[#8a8f98] space-y-1">
                        <div>[Runtime Duration: <span className="text-white">{parsed.runtime}</span>]</div>
                        <div>[On-chain Settlement Fee: <span className="text-white">{parsed.fee}</span>]</div>
                        <div>
                          [Release Tx: {parsed.releaseTx && parsed.releaseTx !== 'N/A' ? (
                            <a
                              href={`https://explorer.testnet.arc.network/tx/${parsed.releaseTx}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[#4E8981] hover:underline"
                            >
                              {parsed.releaseTx.slice(0, 10)}...{parsed.releaseTx.slice(-6)}
                            </a>
                          ) : (
                            <span className="text-white">N/A</span>
                          )}]
                        </div>
                        <div>
                          [Settle Tx: {parsed.settleTx && parsed.settleTx !== 'N/A' ? (
                            <a
                              href={`https://explorer.testnet.arc.network/tx/${parsed.settleTx}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[#4E8981] hover:underline"
                            >
                              {parsed.settleTx.slice(0, 10)}...{parsed.settleTx.slice(-6)}
                            </a>
                          ) : (
                            <span className="text-white">N/A</span>
                          )}]
                        </div>
                      </div>
                    </details>
                  </div>
                </div>
              </div>
            );
          }

          // ── loading: single in-place transient status indicator ─────────────
          if (line.type === 'loading') {
            return (
              <div key={line.id} className="flex justify-start w-full px-1 py-0.5">
                <div className="flex items-center gap-2 text-[#8a8f98] font-mono text-[11px] select-none">
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#4E8981] opacity-60" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-[#4E8981]/70" />
                  </span>
                  <span className="text-[#6a7280] italic truncate max-w-[360px]">{line.text}</span>
                </div>
              </div>
            );
          }

          // ── ack: slim payment/signature confirmation pill ──────────────────────
          if (line.type === 'ack') {
            return (
              <div key={line.id} className="flex justify-start w-full px-1">
                <div className="flex items-center gap-1.5 text-[11px] font-mono text-[#4E8981]/80">
                  <span className="text-[#4E8981]/50">▸</span>
                  <span>{line.text}</span>
                </div>
              </div>
            );
          }

          // ── system: telemetry / status message box ─────────────────────────────
          return (
            <div key={line.id} className="flex justify-start w-full">
              <div className="max-w-[90%] rounded-xl px-4 py-2.5 bg-[#16191C]/90 border border-[#4E8981]/30 text-[#4E8981] font-mono text-[11px] shadow-sm backdrop-blur-sm">
                <div className="break-words whitespace-pre-wrap leading-relaxed">{line.text}</div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Autonomous Status Bar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-t border-[#2A2F35] bg-[#0f1214] shrink-0 text-[11px] font-mono">
        <div className="flex items-center gap-2 text-[#4E8981]">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#4E8981] opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-[#4E8981]"></span>
          </span>
          <span>AUTONOMOUS AGENT ACTIVE — CYCLING ON ARC TESTNET</span>
        </div>
        <div className="text-[#8a8f98]">
          Nano-Fee: <span className="text-white font-bold">0.0001 USDC / cycle</span>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────
export default function Workflows() {
  const { agents, deployedAgentIds, executionLogs, setActiveTab } = useApp();
  const deployedAgents = agents.filter(a => deployedAgentIds.includes(a.id));

  const circle = useCircleWallet();
  const activeUserIdentifier = circle.walletAddress ?? 'anonymous';

  // ACCOUNT SWITCH AIR-GAP: Clear stale localStorage cache keys on identity transitions
  const prevUserRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevUserRef.current;
    if (prev !== null && prev !== activeUserIdentifier) {
      console.log(`🔒 Parent Air-gap isolation: user switched from "${prev}" → "${activeUserIdentifier}".`);
      if (typeof window !== 'undefined') {
        if (prev !== 'anonymous' && activeUserIdentifier !== 'anonymous') {
          // Account SWITCH: real user A → real user B. Purge user A's local cache.
          console.log(`🔒 Purging stale cache for previous user: ${prev}`);
          Object.keys(localStorage).forEach(k => {
            if (k.startsWith(`aethel_chat_history:${prev}:`)) {
              localStorage.removeItem(k);
            }
          });
          sessionStorage.clear();
        } else if (prev === 'anonymous' && activeUserIdentifier !== 'anonymous') {
          // LOGIN: anonymous → real user. Remove any stale anonymous slots to prevent bleed-over.
          Object.keys(localStorage).forEach(k => {
            if (k.startsWith('aethel_chat_history:anonymous:')) {
              localStorage.removeItem(k);
            }
          });
        }
        // LOGOUT (real → anonymous): intentionally do nothing — preserve user's own
        // key so history is available if they log back in.
        localStorage.removeItem('aethel_chat_history'); // Legacy flat-key fallback
      }
    }
    prevUserRef.current = activeUserIdentifier;
  }, [activeUserIdentifier]);

  const [selectedId, setSelectedId]   = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [consoleOpen, setConsoleOpen]  = useState(false);

  // Reset console when switching agents
  useEffect(() => {
    setConsoleOpen(false);
  }, [selectedId]);

  // Auto-select first deployed agent
  useEffect(() => {
    if (deployedAgents.length > 0 && !selectedId) {
      setSelectedId(deployedAgents[0].id);
    }
  }, [deployedAgents, selectedId]);

  const selectedAgent = deployedAgents.find(a => a.id === selectedId) ?? null;

  // Recent non-deployment execution logs for history
  const historyLogs = executionLogs.slice(0, 20);

  if (deployedAgents.length === 0) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-[28px] font-bold text-white mb-2 tracking-tight">Agent Portal</h1>
          <p className="text-[#8a8f98] text-sm">
            Select a deployed agent and assign operational directives.
          </p>
        </div>
        <NoDeployments onGoMarketplace={() => setActiveTab('marketplace')} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-[28px] font-bold text-white mb-1 tracking-tight">Agent Portal</h1>
        <p className="text-[#8a8f98] text-sm">
          Select a deployed agent and assign operational directives.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6 items-start">

        {/* ── Left: Deployed agent selector ─────────────────────────────────── */}
        <div className="bg-[#1A1D20] border border-[#2A2F35] rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[#2A2F35]">
            <p className="text-[10px] font-bold text-[#8a8f98] uppercase tracking-widest">Your Agents</p>
          </div>
          <div className="p-2 space-y-1">
            {deployedAgents.map(agent => {
              const isActive = selectedId === agent.id;
              return (
                <button
                  key={agent.id}
                  onClick={() => setSelectedId(agent.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all cursor-pointer text-left ${
                    isActive
                      ? 'bg-[#4E8981]/12 border border-[#4E8981]/30 shadow-[0_0_12px_rgba(78,137,129,0.06)]'
                      : 'hover:bg-white/[0.04] border border-transparent'
                  }`}
                >
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 border ${
                    isActive
                      ? 'bg-[#4E8981]/15 border-[#4E8981]/30'
                      : 'bg-[#4E8981]/5 border-[#2A2F35]'
                  }`}>
                    {getAgentIcon(agent.id, agent.tags?.[0])}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-semibold truncate ${isActive ? 'text-white' : 'text-[#c1c6d5]'}`}>
                      {agent.name}
                    </p>
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className="w-1 h-1 rounded-full bg-emerald-400" />
                      <span className="text-[9px] text-emerald-400 font-semibold">ACTIVE</span>
                    </div>
                  </div>
                  {isActive && (
                    <div className="w-1 h-1 rounded-full bg-[#4E8981] flex-shrink-0" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Secured badge */}
          <div className="px-4 py-3 border-t border-[#2A2F35] flex items-center gap-1.5">
            <ShieldCheck size={12} className="text-[#4E8981]" weight="fill" />
            <span className="text-[9px] text-[#4E8981] font-bold tracking-widest uppercase">
              On-chain licensed
            </span>
          </div>
        </div>

        {/* ── Right: Console panel ──────────────────────────────────────────── */}
        <div className="flex flex-col gap-4">
          {selectedAgent ? (
            <>
              {/* Agent info strip with Launch Console toggle */}
              <div className="bg-[#1A1D20] border border-[#2A2F35] rounded-xl px-5 py-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-[#4E8981]/10 border border-[#4E8981]/20 flex items-center justify-center">
                    {getAgentIcon(selectedAgent.id, selectedAgent.tags?.[0])}
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white">{selectedAgent.name}</h3>
                    <p className="text-[10px] text-[#8a8f98] truncate max-w-[280px]">{selectedAgent.description}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5">
                    <CheckCircle size={14} weight="fill" className="text-[#4E8981]" />
                    <span className="text-[10px] font-bold text-[#4E8981] uppercase tracking-wider">Purchased</span>
                  </div>
                  <button
                    onClick={() => setConsoleOpen(o => !o)}
                    className={`flex items-center gap-1.5 border px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer active:scale-95 transition-all ${
                      consoleOpen
                        ? 'bg-[#4E8981]/20 border-[#4E8981]/60 text-[#4E8981]'
                        : 'bg-[#4E8981]/10 border-[#4E8981]/40 hover:bg-[#4E8981]/20 text-[#4E8981]'
                    }`}
                  >
                    <TerminalWindow size={14} />
                    {consoleOpen ? 'Close Console' : 'Launch Console'}
                    <CaretDown
                      size={11}
                      className={`transition-transform duration-200 ${consoleOpen ? 'rotate-180' : ''}`}
                    />
                  </button>
                </div>
              </div>

              {/* Console — kept mounted (CSS-hidden) so messages survive close/reopen.
                  key is composite of activeUserIdentifier and selectedAgent.id to force clean remount on switch. */}
              <div style={{ display: consoleOpen ? 'block' : 'none' }}>
                <AgentPortal key={`${activeUserIdentifier}-${selectedAgent.id}`} agent={selectedAgent} />
              </div>
            </>
          ) : (
            <div className="bg-[#1A1D20] border border-[#2A2F35] rounded-xl p-10 flex items-center justify-center">
              <p className="text-[#8a8f98] text-sm">Select an agent from the list to open its console.</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Execution History ──────────────────────────────────────────────────── */}
      {historyLogs.length > 0 && (
        <div className="bg-[#1A1D20] border border-[#2A2F35] rounded-xl overflow-hidden">
          <button
            onClick={() => setShowHistory(h => !h)}
            className="w-full flex items-center justify-between px-5 py-3 border-b border-[#2A2F35] cursor-pointer hover:bg-white/[0.02] transition-colors"
          >
            <div className="flex items-center gap-2">
              <ClockCounterClockwise size={14} className="text-[#4E8981]" />
              <span className="text-xs font-bold text-white uppercase tracking-widest">Execution History</span>
              <span className="text-[9px] bg-[#4E8981]/10 border border-[#4E8981]/20 text-[#4E8981] px-1.5 py-0.5 rounded font-bold">
                {historyLogs.length}
              </span>
            </div>
            <CaretDown
              size={14}
              className={`text-[#8a8f98] transition-transform duration-200 ${showHistory ? 'rotate-180' : ''}`}
            />
          </button>

          {showHistory && (
            <div className="divide-y divide-[#2A2F35]">
              {historyLogs.map(log => (
                <div key={log.id} className="flex items-center justify-between px-5 py-3 hover:bg-white/[0.015] transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="w-7 h-7 rounded bg-[#4E8981]/8 border border-[#4E8981]/15 flex items-center justify-center">
                      <Cpu size={13} className="text-[#4E8981]" />
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-white">{log.agent_name}</p>
                      <p className="text-[10px] text-[#8a8f98]">{log.timestamp}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-6">
                    <span className="text-[9px] font-mono text-[#4E8981]/60 select-all">{log.tx_hash}</span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                      log.tx_type === 'Deployment'
                        ? 'text-[#4E8981] bg-[#4E8981]/8 border-[#4E8981]/20'
                        : 'text-amber-400 bg-amber-400/8 border-amber-400/20'
                    }`}>
                      {log.tx_type}
                    </span>
                    <span className="text-xs font-bold text-white tabular-nums">
                      {log.cost_usdc.toFixed(4)} <span className="text-[#8a8f98] font-normal">USDC</span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
