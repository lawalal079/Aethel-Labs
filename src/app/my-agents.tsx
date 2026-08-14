'use client';

import React, { useState } from 'react';
import { useApp } from './context';
import {
  Cpu, ShieldCheck, TrendUp, ChartLine, FileText, Code, Translate, Image as ImageIcon,
  ArrowRight, Gear, Play, Stop, Spinner, Robot, Clock, ArrowClockwise, Copy, CheckSquare,
} from '@phosphor-icons/react';

// Matches the sidebar My Agents double-gear icon (without checkmark badge)
const AgentSettingsIcon = () => (
  <svg viewBox="0 0 32 32" className="w-8 h-8" fill="none" xmlns="http://www.w3.org/2000/svg">
    {/* Large gear (bottom-left) */}
    <circle cx="12" cy="20" r="4.5" stroke="currentColor" strokeWidth="2.2" />
    <path d="M12 12.5v3M12 24.5v3M4.5 20h3M19.5 20h3M6.7 14.7l2.1 2.1M15.2 23.2l2.1 2.1M6.7 25.3l2.1-2.1M15.2 16.8l2.1-2.1" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    {/* Small gear (top-right) */}
    <circle cx="21" cy="11" r="2.8" stroke="currentColor" strokeWidth="2.2" />
    <path d="M21 5.5v2.5M21 14v2.5M15.5 11h2.5M24 11h2.5M17.1 7.1l1.8 1.8M23.1 13.1l1.8 1.8M17.1 14.9l1.8-1.8M23.1 7.1l1.8-1.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const getAgentIcon = (id: string, iconName?: string) => {
  switch (iconName) {
    case 'TrendingUp':  return <TrendUp     size={20} className="text-[#4E8981]" weight="fill" />;
    case 'TrendUp':     return <TrendUp     size={20} className="text-[#4E8981]" weight="fill" />;
    case 'ChartLine':   return <ChartLine   size={20} className="text-[#4E8981]" weight="fill" />;
    case 'FileText':    return <FileText    size={20} className="text-[#4E8981]" weight="fill" />;
    case 'Code':        return <Code        size={20} className="text-[#4E8981]" weight="fill" />;
    case 'Translate':   return <Translate   size={20} className="text-[#4E8981]" weight="fill" />;
    case 'Image':       return <ImageIcon   size={20} className="text-[#4E8981]" weight="fill" />;
    case 'ShieldCheck': return <ShieldCheck size={20} className="text-[#4E8981]" weight="fill" />;
    case 'Gear':        return <Gear        size={20} className="text-[#4E8981]" weight="fill" />;
  }
  switch (id) {
    case 'agent_data_analysis':    return <ChartLine   size={20} className="text-[#4E8981]" weight="fill" />;
    case 'agent_content_writing':  return <FileText    size={20} className="text-[#4E8981]" weight="fill" />;
    case 'agent_python_coding':    return <Code        size={20} className="text-[#4E8981]" weight="fill" />;
    case 'agent_lang_translation': return <Translate   size={20} className="text-[#4E8981]" weight="fill" />;
    case 'agent_image_gen':        return <ImageIcon   size={20} className="text-[#4E8981]" weight="fill" />;
    case 'agent_ai_moderation':    return <ShieldCheck size={20} className="text-[#4E8981]" weight="fill" />;
    default:                       return <Cpu         size={20} className="text-[#4E8981]" weight="fill" />;
  }
};

// ─── Glassmorphic Empty State ──────────────────────────────────────────────────
function EmptyDeployments({ onBrowse }: { onBrowse: () => void }) {
  return (
    <div className="flex items-center justify-center py-16">
      <div
        className="relative max-w-md w-full rounded-2xl border border-[#4E8981]/20 p-10 text-center overflow-hidden"
        style={{
          background: 'linear-gradient(135deg, rgba(78,137,129,0.06) 0%, rgba(11,11,12,0.9) 60%, rgba(78,137,129,0.04) 100%)',
          backdropFilter: 'blur(16px)',
          boxShadow: '0 0 60px rgba(78,137,129,0.06), inset 0 1px 0 rgba(78,137,129,0.12)',
        }}
      >
        {/* Decorative corner glow */}
        <div className="absolute top-0 right-0 w-32 h-32 bg-[#4E8981]/5 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-[#4E8981]/4 rounded-full blur-2xl pointer-events-none" />

        {/* Icon */}
        <div className="relative w-16 h-16 mx-auto mb-6 rounded-2xl border border-[#4E8981]/20 bg-[#4E8981]/5 flex items-center justify-center text-[#4E8981]">
          <AgentSettingsIcon />
          <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-[#2A2F35] border border-[#0B0B0C] flex items-center justify-center">
            <span className="w-1.5 h-1.5 rounded-full bg-[#8a8f98]" />
          </span>
        </div>

        {/* Text */}
        <h2 className="text-white text-xl font-bold tracking-tight mb-2">
          No Active Deployments Detected
        </h2>
        <p className="text-[#8a8f98] text-sm leading-relaxed mb-8">
          Your deployment grid is empty. Browse the marketplace to acquire and activate an AI agent for your operations.
        </p>

        {/* Step hints */}
        <div className="flex items-center justify-center gap-3 text-[10px] text-[#8a8f98] mb-8 font-mono">
          <span className="px-2 py-0.5 border border-[#2A2F35] rounded">01 Browse</span>
          <ArrowRight size={10} className="text-[#4E8981]" />
          <span className="px-2 py-0.5 border border-[#2A2F35] rounded">02 Deploy</span>
          <ArrowRight size={10} className="text-[#4E8981]" />
          <span className="px-2 py-0.5 border border-[#4E8981]/30 rounded text-[#4E8981]">03 Operate</span>
        </div>

        {/* CTA button */}
        <button
          onClick={onBrowse}
          className="group relative inline-flex items-center gap-2 bg-[#4E8981]/10 hover:bg-[#4E8981]/20 border border-[#4E8981]/40 hover:border-[#4E8981]/70 text-[#4E8981] font-bold px-8 py-3 rounded-xl text-sm tracking-widest uppercase transition-all duration-200 active:scale-95 cursor-pointer"
          style={{ boxShadow: '0 0 20px rgba(78,137,129,0.08)' }}
        >
          <span>Browse Marketplace</span>
          <ArrowRight
            size={16}
            weight="bold"
            className="group-hover:translate-x-0.5 transition-transform duration-200"
          />
        </button>
      </div>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────
export default function MyAgents() {
  const {
    agents, deployedAgentIds, daemonStatus, isDeployingDaemon,
    startDaemonForAgent, stopDaemonForAgent, refreshDaemonStatus,
    setActiveTab, setSelectedAgentForDeploy, spendingBalance,
  } = useApp();

  const [isActionLoading, setIsActionLoading] = useState<string | null>(null);

  // Deployed or running agents
  const visibleAgents = agents.filter(a =>
    deployedAgentIds.includes(a.id) ||
    Boolean(daemonStatus?.running && (daemonStatus?.agentId === a.id || (!daemonStatus?.agentId && a.id === 'agent_smc_alpha_executor')))
  );

  const handleBrowseMarketplace = () => {
    setActiveTab('marketplace');
  };

  const handleToggleDaemon = async (agentId: string, isRunning: boolean) => {
    setIsActionLoading(agentId);
    try {
      if (isRunning) {
        await stopDaemonForAgent();
      } else {
        await startDaemonForAgent(agentId);
      }
    } finally {
      setIsActionLoading(null);
    }
  };

  const formatUptime = (seconds?: number) => {
    if (!seconds || seconds <= 0) return '0s';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m === 0) return `${s}s`;
    const h = Math.floor(m / 60);
    const remM = m % 60;
    if (h === 0) return `${m}m ${s}s`;
    return `${h}h ${remM}m`;
  };

  const formatLastCycle = (lastCycleAt?: number | null) => {
    if (!lastCycleAt) return 'Cycle in progress...';
    const diffSec = Math.max(0, Math.floor((Date.now() - lastCycleAt) / 1000));
    if (diffSec < 5) return 'Just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    return `${Math.floor(diffSec / 60)}m ago`;
  };

  return (
    <div className="space-y-10">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold font-sans text-[#e5e2e1] mb-2 tracking-tight">
            Agent Portal &amp; Deployments
          </h1>
          <p className="text-[#c1c6d5] text-sm">
            Monitor live execution loops, manage autonomous daemons, and configure operational directives.
          </p>
        </div>
        <button
          onClick={() => void refreshDaemonStatus()}
          className="flex items-center gap-2 px-3.5 py-2 bg-[#1A1D20] border border-[#2A2F35] hover:border-[#4E8981]/50 text-[#8a8f98] hover:text-white rounded-xl text-xs font-semibold transition-colors cursor-pointer"
        >
          <ArrowClockwise size={14} />
          <span>Refresh Status</span>
        </button>
      </div>

      {/* Empty state */}
      {visibleAgents.length === 0 && (
        <EmptyDeployments onBrowse={handleBrowseMarketplace} />
      )}

      {/* Agent cards grid */}
      {visibleAgents.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {visibleAgents.map((agent) => {
            const isTradingAgent = ['agent_smc_alpha_executor', 'agent_crossdex_arb', 'agent_risk_rebalancer'].includes(agent.id) ||
                                   (agent.category?.toLowerCase() || '').includes('trading') ||
                                   (agent.category?.toLowerCase() || '').includes('defi');

            const isDaemonRunning = Boolean(
              daemonStatus?.running && daemonStatus?.agentId === agent.id
            );
            const isLoading = isActionLoading === agent.id || (isDaemonRunning ? false : isDeployingDaemon);

            return (
              <div
                key={agent.id}
                className={`bg-[#1A1D20] border rounded-2xl p-6 transition-all shadow-xl flex flex-col justify-between ${
                  isDaemonRunning ? 'border-[#4E8981]/60 bg-[#1A1D20]' : 'border-[#2A2F35]'
                }`}
              >
                <div>
                  {/* Top Bar: Icon, Name & Status Pill */}
                  <div className="flex justify-between items-start mb-6">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-xl bg-[#4E8981]/10 border border-[#4E8981]/30 flex items-center justify-center text-[#4E8981] flex-shrink-0">
                        {getAgentIcon(agent.id, agent.icon)}
                      </div>
                      <div>
                        <h3 className="text-lg font-bold text-white tracking-tight">{agent.name}</h3>
                        <p className="text-[11px] text-[#8a8f98] font-mono">{agent.id}</p>
                      </div>
                    </div>

                    {isTradingAgent ? (
                      isDaemonRunning ? (
                        <div className="flex items-center gap-2 px-3 py-1 bg-[#4E8981]/15 text-[#4E8981] rounded-full border border-[#4E8981]/40 animate-pulse">
                          <span className="w-2 h-2 rounded-full bg-[#4E8981]" />
                          <span className="text-[10px] font-bold uppercase tracking-wider">DAEMON RUNNING</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 px-3 py-1 bg-amber-500/10 text-amber-400 rounded-full border border-amber-500/30">
                          <span className="w-2 h-2 rounded-full bg-amber-400" />
                          <span className="text-[10px] font-bold uppercase tracking-wider">DAEMON PAUSED</span>
                        </div>
                      )
                    ) : (
                      <div className="flex items-center gap-2 px-3 py-1 bg-[#4E8981]/15 text-[#4E8981] rounded-full border border-[#4E8981]/30">
                        <ShieldCheck size={12} weight="fill" />
                        <span className="text-[10px] font-bold uppercase tracking-wider">SECURED &amp; READY</span>
                      </div>
                    )}
                  </div>

                  <p className="text-xs text-[#8a8f98] leading-relaxed mb-6">
                    {agent.description}
                  </p>

                  {/* Telemetry / Status Panel */}
                  {isTradingAgent && isDaemonRunning ? (
                    <div className="bg-[#0B0B0C] border border-[#4E8981]/25 rounded-xl p-4 mb-6 space-y-3">
                      <div className="flex items-center justify-between text-xs pb-2 border-b border-[#2A2F35]">
                        <span className="text-[#8a8f98] flex items-center gap-1.5">
                          <Robot size={14} className="text-[#4E8981]" /> Execution Daemon
                        </span>
                        <span className="text-[#4E8981] font-mono font-bold">Active ({daemonStatus?.intervalSeconds ?? 60}s Loop)</span>
                      </div>

                      <div className="grid grid-cols-3 gap-2 py-1">
                        <div className="bg-[#1A1D20] p-2.5 rounded-lg border border-[#2A2F35]">
                          <span className="text-[9px] text-[#8a8f98] uppercase block font-bold">Completed Cycles</span>
                          <span className="text-sm font-bold font-mono text-white mt-0.5 block">
                            {daemonStatus?.cycleCount ?? 0}
                          </span>
                        </div>
                        <div className="bg-[#1A1D20] p-2.5 rounded-lg border border-[#2A2F35]">
                          <span className="text-[9px] text-[#8a8f98] uppercase block font-bold">Uptime</span>
                          <span className="text-sm font-bold font-mono text-white mt-0.5 block">
                            {formatUptime(daemonStatus?.uptimeSeconds)}
                          </span>
                        </div>
                        <div className="bg-[#1A1D20] p-2.5 rounded-lg border border-[#2A2F35]">
                          <span className="text-[9px] text-[#8a8f98] uppercase block font-bold">Last Cycle</span>
                          <span className="text-xs font-bold font-mono text-[#4E8981] mt-1 block truncate">
                            {formatLastCycle(daemonStatus?.lastCycleAt)}
                          </span>
                        </div>
                      </div>

                      {daemonStatus?.tradingWalletAddress && (
                        <div className="flex items-center justify-between pt-1 text-[11px]">
                          <span className="text-[#8a8f98]">Trading Wallet:</span>
                          <code className="text-[#60a5fa] font-mono bg-[#1A1D20] px-2 py-0.5 rounded border border-[#3b82f6]/20">
                            {`${daemonStatus.tradingWalletAddress.slice(0, 8)}...${daemonStatus.tradingWalletAddress.slice(-6)}`}
                          </code>
                        </div>
                      )}
                    </div>
                  ) : isTradingAgent ? (
                    <div className="bg-[#0B0B0C] border border-[#2A2F35] rounded-xl p-4 mb-6">
                      <div className="flex items-start gap-3">
                        <Gear size={20} className="text-amber-400/80 flex-shrink-0 mt-0.5" />
                        <div>
                          <p className="text-xs text-[#8a8f98] leading-relaxed">
                            License verified on-chain. Launch the autonomous daemon to begin execution cycles.
                          </p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="bg-[#0B0B0C] border border-[#2A2F35] rounded-xl p-4 mb-6">
                      <div className="flex items-start gap-3">
                        <ShieldCheck size={20} className="text-[#4E8981] flex-shrink-0 mt-0.5" />
                        <div>
                          <p className="text-xs text-[#8a8f98] leading-relaxed">
                            License verified on-chain. Ready for on-demand task execution and custom mission workflows.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Card Footer Controls */}
                <div className="flex items-center gap-3 pt-4 border-t border-[#2A2F35]">
                  {isTradingAgent ? (
                    <>
                          {isDaemonRunning ? (
                            <button
                              id={`stop-daemon-${agent.id}`}
                              disabled={isLoading}
                              onClick={() => void handleToggleDaemon(agent.id, true)}
                              className="flex-1 py-2.5 bg-rose-950/20 border border-rose-900/40 hover:border-rose-600 text-rose-400 hover:text-rose-300 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-50"
                            >
                              {isLoading ? <Spinner size={14} className="animate-spin" /> : <Stop size={14} weight="fill" />}
                              <span>Stop Agent</span>
                            </button>
                          ) : (
                            <button
                              id={`start-daemon-${agent.id}`}
                              disabled={isLoading}
                              onClick={() => void handleToggleDaemon(agent.id, false)}
                              className="flex-1 py-2.5 bg-[#4E8981] hover:bg-[#4E8981]/90 text-white rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-1.5 shadow-lg active:scale-95 disabled:opacity-50"
                            >
                              {isLoading ? <Spinner size={14} className="animate-spin" /> : <Play size={14} weight="fill" />}
                              <span>Start Agent</span>
                            </button>
                          )}

                          <button
                            onClick={() => {
                              setSelectedAgentForDeploy(agent);
                              setActiveTab('workflows');
                            }}
                            className="flex-1 py-2.5 bg-transparent border border-[#2A2F35] hover:border-[#4E8981]/50 text-[#8a8f98] hover:text-white rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-1.5"
                          >
                            <span>Execute Mission</span>
                            <ArrowRight size={12} weight="bold" />
                          </button>
                        </>
                      ) : (
                      <button
                        onClick={() => {
                          setSelectedAgentForDeploy(agent);
                          setActiveTab('workflows');
                        }}
                        className="w-full py-3 bg-[#4E8981] hover:bg-[#4E8981]/90 text-white rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-2 shadow-lg active:scale-95"
                      >
                        <span>Execute Mission</span>
                        <ArrowRight size={14} weight="bold" />
                      </button>
                    )}
                  </div>
                </div>
              );
          })}
        </div>
      )}
    </div>
  );
}
