'use client';

import React, { useState } from 'react';
import { useApp } from './context';
import { Play, Shield, Terminal, ArrowClockwise, Copy, Download, CheckCircle, Cpu, HardDrive } from '@phosphor-icons/react';

export default function ExecutionPanel() {
  const {
    selectedAgentForDeploy,
    runMission,
    agents,
    executionLogs,
    missionStatus,
    missionLogs,
    missionResult
  } = useApp();

  const [missionText, setMissionText] = useState('');
  const [modelPreference, setModelPreference] = useState('Æthel Labs Core 4.0 (Recommended)');
  const [tokenBudget, setTokenBudget] = useState(1500);
  const [verificationLevel, setVerificationLevel] = useState(true);
  const [dataPersistence, setDataPersistence] = useState(false);

  // Default to first agent if none is selected
  const activeAgent = selectedAgentForDeploy || agents[0];

  const executing = missionStatus === 'Running';

  const handleExecute = async () => {
    if (executing) return;

    // Find the deployment txHash for the active agent from execution logs
    const deployLog = executionLogs.find(
      (log) => log.agent_id === activeAgent.id && log.tx_type === 'Deployment'
    );
    const txHash = deployLog?.tx_hash || '0x' + '0'.repeat(40);

    try {
      await runMission(missionText, activeAgent.id, txHash);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="flex flex-col h-full space-y-6">
      {/* Page Header */}
      <div>
        <h2 className="text-3xl font-bold text-[#e5e2e1] mb-1 tracking-tight">Checkout &amp; Execution</h2>
        <p className="text-[#c1c6d5] text-sm">Configure parameters and monitor real-time agent output.</p>
      </div>

      <div className="flex-1 flex flex-col lg:flex-row gap-6 min-h-0">
        {/* Left Side: Input Configuration Matrix */}
        <section className="flex-1 bg-white rounded-xl flex flex-col border border-[#414753]/15 overflow-hidden">
          <div className="p-6 border-b border-neutral-100 flex justify-between items-center bg-white">
            <h2 className="text-[#131313] text-xl font-bold tracking-tight">Input Matrix</h2>
            <div className="flex items-center gap-2 bg-neutral-100 px-3 py-1 rounded-full">
              <span className={`w-2 h-2 rounded-full ${executing ? 'bg-amber-500 animate-ping' : 'bg-[#0066cc]'}`}></span>
              <span className="text-neutral-600 font-bold text-[10px] uppercase tracking-wider">
                {executing ? 'PROCESSING' : 'READY'}
              </span>
            </div>
          </div>

          <div className="flex-1 p-6 space-y-6 overflow-y-auto">
            {/* Display Active Agent Info */}
            <div className="p-4 bg-neutral-50 rounded-lg border border-neutral-100 flex items-start gap-3">
              <Cpu size={28} className="text-[#0066cc] mt-0.5" weight="fill" />
              <div>
                <h3 className="font-bold text-neutral-800 text-sm">Active Module: {activeAgent.name}</h3>
                <p className="text-xs text-neutral-500 mt-0.5">{activeAgent.description}</p>
                <div className="text-[10px] text-neutral-400 mt-1 font-semibold uppercase tracking-wider">
                  Cost per Run: {activeAgent.usdc_price.toFixed(2)} USDC + 0.05 USDC compute gas
                </div>
              </div>
            </div>

            {/* Mission input */}
            <div className="space-y-2">
              <label className="text-neutral-700 font-bold text-xs uppercase tracking-wider block">Agent Mission</label>
              <textarea
                value={missionText}
                onChange={(e) => setMissionText(e.target.value)}
                className="w-full h-28 bg-white border border-neutral-200 rounded-lg p-3 text-neutral-800 focus:border-[#0066cc] focus:ring-1 focus:ring-[#0066cc] transition-all resize-none text-sm leading-relaxed"
                placeholder="Describe the workflow or task execution logic..."
              />
            </div>

            {/* Model & Budget selection */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-neutral-700 font-bold text-xs uppercase tracking-wider block">Model Preference</label>
                <div className="relative">
                  <select
                    value={modelPreference}
                    onChange={(e) => setModelPreference(e.target.value)}
                    className="w-full appearance-none bg-white border border-neutral-200 rounded-lg px-3 py-2.5 text-xs text-neutral-800 font-semibold focus:border-[#0066cc] focus:ring-0 transition-all cursor-pointer"
                  >
                    <option>Æthel Labs Core 4.0 (Recommended)</option>
                    <option>Æthel Labs DeepReason v2</option>
                    <option>Turbo-Institutional 8k</option>
                  </select>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-neutral-700 font-bold text-xs uppercase tracking-wider block">Token Budget</label>
                <div className="relative">
                  <input
                    type="number"
                    value={tokenBudget}
                    onChange={(e) => setTokenBudget(parseInt(e.target.value) || 0)}
                    className="w-full bg-white border border-neutral-200 rounded-lg px-3 py-2.5 text-xs font-semibold text-neutral-800 focus:border-[#0066cc] focus:ring-0 transition-all"
                  />
                  <span className="absolute right-3 top-2.5 text-neutral-400 font-semibold text-[10px] uppercase tracking-wider">MAX</span>
                </div>
              </div>
            </div>

            {/* Switch sliders / checkboxes */}
            <div className="space-y-3">
              <label className="text-neutral-700 font-bold text-xs uppercase tracking-wider block">Execution Parameters</label>

              <div
                onClick={() => setVerificationLevel(!verificationLevel)}
                className="flex items-center gap-4 p-3 border border-neutral-100 rounded-lg group hover:border-[#0066cc] transition-colors cursor-pointer"
              >
                <div className="w-8 h-8 rounded bg-neutral-50 flex items-center justify-center text-neutral-600">
                  <Shield size={18} />
                </div>
                <div className="flex-1">
                  <p className="text-neutral-800 font-semibold text-xs">Verification Level</p>
                  <p className="text-neutral-400 text-[10px]">Enforce multi-hop logic validation</p>
                </div>
                <div>
                  <input
                    type="checkbox"
                    checked={verificationLevel}
                    readOnly
                    className="w-4 h-4 text-[#0066cc] border-neutral-300 rounded focus:ring-[#0066cc] pointer-events-none"
                  />
                </div>
              </div>

              <div
                onClick={() => setDataPersistence(!dataPersistence)}
                className="flex items-center gap-4 p-3 border border-neutral-100 rounded-lg group hover:border-[#0066cc] transition-colors cursor-pointer"
              >
                <div className="w-8 h-8 rounded bg-neutral-50 flex items-center justify-center text-neutral-600">
                  <HardDrive size={18} />
                </div>
                <div className="flex-1">
                  <p className="text-neutral-800 font-semibold text-xs">Data Persistence</p>
                  <p className="text-neutral-400 text-[10px]">Auto-save execution context to secure vault</p>
                </div>
                <div>
                  <input
                    type="checkbox"
                    checked={dataPersistence}
                    readOnly
                    className="w-4 h-4 text-[#0066cc] border-neutral-300 rounded focus:ring-[#0066cc] pointer-events-none"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="p-6 bg-neutral-50 border-t border-neutral-100 mt-auto">
            <button
              onClick={handleExecute}
              disabled={executing}
              className="w-full bg-[#0066cc] text-white py-4 rounded-lg font-bold text-sm tracking-wider uppercase flex items-center justify-center gap-2 hover:bg-[#0052a3] active:scale-[0.98] transition-all disabled:opacity-70 disabled:cursor-not-allowed cursor-pointer shadow-md shadow-[#0066cc]/15"
            >
              {executing ? (
                <>
                  <ArrowClockwise className="animate-spin" size={18} />
                  Processing Execution...
                </>
              ) : (
                <>
                  <Play weight="fill" size={18} />
                  Initialize Execution
                </>
              )}
            </button>
          </div>
        </section>

        {/* Right Side: Live Viewport Output */}
        <section className="flex-1 bg-[#0e0e0e] rounded-xl flex flex-col border border-[#414753]/15 overflow-hidden">
          <div className="p-4 border-b border-[#414753]/15 flex justify-between items-center bg-[#131313]">
            <div className="flex items-center gap-3">
              <Terminal className="text-[#aac7ff]" size={20} />
              <h2 className="text-[#e5e2e1] text-xs font-semibold uppercase tracking-widest">Live Viewport</h2>
            </div>
            <div className="flex gap-1">
              <button className="p-2 hover:bg-[#2a2a2a] rounded text-[#c1c6d5] hover:text-white transition-colors cursor-pointer">
                <Download size={16} />
              </button>
              <button className="p-2 hover:bg-[#2a2a2a] rounded text-[#c1c6d5] hover:text-white transition-colors cursor-pointer">
                <Copy size={16} />
              </button>
            </div>
          </div>

          <div className="flex-1 p-8 overflow-y-auto space-y-6">
            {/* Waiting Placeholder */}
            {missionStatus === 'Idle' && (
              <div className="h-full flex flex-col items-center justify-center text-center space-y-3 opacity-40">
                <div className="w-16 h-16 border-2 border-dashed border-[#8b919e] rounded-full flex items-center justify-center">
                  <Terminal size={32} />
                </div>
                <p className="text-xs font-bold tracking-wider uppercase text-[#c1c6d5]">Waiting for Initialization</p>
              </div>
            )}

            {/* Live Streaming Logs / Running State */}
            {missionStatus === 'Running' && (
              <div className="h-full flex flex-col space-y-4">
                <div className="flex items-center gap-2 text-xs font-bold text-[#aac7ff] select-none">
                  <span className="w-2 h-2 bg-amber-500 rounded-full animate-ping"></span>
                  STREAMING TELEMETRY LOGS...
                </div>
                <div className="flex-1 min-h-[300px] border border-[#2A2F35]/50 bg-[#070708]/85 rounded-lg p-5 font-mono text-[11px] leading-relaxed text-[#aac7ff] overflow-y-auto space-y-2 scrollbar-none">
                  {missionLogs.map((log, idx) => (
                    <div key={idx} className="whitespace-pre-wrap animate-fadeIn select-text selection:bg-[#aac7ff]/20">
                      <span className="text-[#8a8f98] mr-2">[{idx.toString().padStart(2, '0')}]</span> {log}
                    </div>
                  ))}
                  <div className="animate-pulse text-amber-500">█</div>
                </div>
              </div>
            )}

            {/* Success Result View */}
            {missionStatus === 'Success' && (
              <div className="space-y-6 animate-fadeIn">
                <div className="flex items-center gap-2">
                  <CheckCircle size={22} className="text-[#80ff9a]" weight="fill" />
                  <h1 className="text-xl font-bold text-white tracking-tight">Execution Result</h1>
                </div>
                
                <div className="p-5 border border-[#2A2F35]/50 bg-[#070708]/85 rounded-lg font-mono text-[11px] leading-relaxed text-[#80ff9a] whitespace-pre-wrap select-text">
                  {missionResult}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 bg-[#1c1b1b] border border-[#414753]/10 rounded-lg">
                    <span className="text-[#aac7ff] text-[10px] font-bold tracking-wider uppercase block mb-1">Status</span>
                    <p className="text-[#80ff9a] text-lg font-bold tracking-tight">SUCCESS</p>
                  </div>
                  <div className="p-4 bg-[#1c1b1b] border border-[#414753]/10 rounded-lg">
                    <span className="text-[#aac7ff] text-[10px] font-bold tracking-wider uppercase block mb-1">Telemetry Sync</span>
                    <p className="text-white text-lg font-bold tracking-tight">COMPLETED</p>
                  </div>
                </div>

                <div className="p-5 border border-[#2A2F35]/50 bg-[#070708]/60 rounded-lg max-h-[180px] overflow-y-auto space-y-1.5 scrollbar-none select-text">
                  <h3 className="text-xs font-bold text-neutral-400 uppercase tracking-widest mb-2">Final Execution Log</h3>
                  {missionLogs.map((log, idx) => (
                    <div key={idx} className="font-mono text-[10px] text-[#8a8f98] leading-tight">
                      [{idx.toString().padStart(2, '0')}] {log}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Failed Result View */}
            {missionStatus === 'Failed' && (
              <div className="space-y-6 animate-fadeIn">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 bg-[#ff8080] rounded-full animate-pulse"></div>
                  <h1 className="text-xl font-bold text-[#ff8080] tracking-tight">Execution Aborted</h1>
                </div>

                <div className="p-5 border border-[#ff8080]/20 bg-[#1a0e0e]/50 rounded-lg font-mono text-[11px] leading-relaxed text-[#ff8080] whitespace-pre-wrap select-text">
                  {missionResult || 'Check transaction validation, escrow balance, or engine server status.'}
                </div>

                <div className="p-5 border border-[#2A2F35]/50 bg-[#070708]/60 rounded-lg max-h-[180px] overflow-y-auto space-y-1.5 scrollbar-none select-text">
                  <h3 className="text-xs font-bold text-neutral-400 uppercase tracking-widest mb-2 font-mono">Trace Logs</h3>
                  {missionLogs.map((log, idx) => (
                    <div key={idx} className="font-mono text-[10px] text-[#8a8f98] leading-tight">
                      [{idx.toString().padStart(2, '0')}] {log}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Console status bar */}
          <div className="h-10 border-t border-[#414753]/15 flex items-center px-4 justify-between text-[10px] font-bold text-[#c1c6d5] bg-[#1c1b1b]">
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                ENGINE ACTIVE
              </span>
              <span>LATENCY: 42MS</span>
            </div>
            <div>SECURED BY USDC CLEARING</div>
          </div>
        </section>
      </div>
    </div>
  );
}
