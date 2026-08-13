'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Bell, Question } from '@phosphor-icons/react';
import { useWalletDisplay, useCircleWallet } from './components/providers/CircleWalletProvider';
import { useApp } from './context';

export default function Header() {
  const [mounted, setMounted] = useState(false);
  const { shortAddress, walletBalance, spendingBalance, isConnected, authStatusMessage } = useWalletDisplay();
  const { loginWithGoogle, logout, isConnecting, walletAddress, feeWalletAddress, feeWalletBalance, tradingWalletAddress } = useCircleWallet();
  const { topUpBalance, executionLogs } = useApp();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [notifsOpen, setNotifsOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setMounted(true); }, []);

  const isActuallyConnected = mounted && isConnected;

  const displayFeeAddress = feeWalletAddress ?? tradingWalletAddress ?? null;
  const shortFeeAddress = displayFeeAddress
    ? `${displayFeeAddress.slice(0, 6)}...${displayFeeAddress.slice(-4)}`
    : 'Provisioning...';

  const handleCopy = () => {
    if (displayFeeAddress) {
      navigator.clipboard.writeText(displayFeeAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
      if (notifRef.current && !notifRef.current.contains(event.target as Node)) {
        setNotifsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <header className="bg-transparent w-full z-40">
      <div className="flex justify-between items-center py-4 w-full">

        {/* ── Logo ─────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-8">
          <h1 className="text-2xl font-bold text-white tracking-wide"
            style={{ textShadow: '-2px 0 #00F0FF, 2px 0 #FF4A1C' }}>
            Æthel Labs
          </h1>
        </div>

        {/* ── Right Actions ────────────────────────────────────────────── */}
        <div className="flex items-center gap-4">

          {/* Notifications */}
          <div className="relative" ref={notifRef}>
            <button
              id="header-notifications-btn"
              onClick={() => setNotifsOpen(!notifsOpen)}
              className="text-[#8a8f98] hover:text-white cursor-pointer transition-colors p-1.5 rounded-lg relative"
            >
              <Bell size={20} />
              {(executionLogs ?? []).length > 0 && (
                <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-[#00F0FF] animate-pulse" />
              )}
            </button>

            {notifsOpen && (
              <div className="absolute right-0 top-full mt-2 w-80 bg-[#131619] border border-[#23272C] rounded-2xl shadow-2xl p-4 z-50 flex flex-col gap-3">
                <div className="flex justify-between items-center border-b border-[#23272C] pb-2">
                  <span className="text-xs font-bold text-white tracking-wider uppercase">Execution Logs</span>
                  <span className="text-[10px] text-[#8a8f98] font-mono">{(executionLogs ?? []).length} events</span>
                </div>
                <div className="max-h-60 overflow-y-auto flex flex-col gap-2">
                  {(executionLogs ?? []).length === 0 ? (
                    <span className="text-xs text-[#8a8f98] py-4 text-center">No execution logs yet.</span>
                  ) : (
                    (executionLogs ?? []).slice(0, 5).map((log, i) => (
                      <div key={i} className="p-2.5 bg-[#1A1D20] border border-[#2A2F35] rounded-xl flex flex-col gap-1">
                        <p className="text-[11px] text-[#8a8f98] line-clamp-2 leading-tight">{log.tx_type} — {log.status}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Help */}
          <button
            id="header-help-btn"
            className="text-[#8a8f98] hover:text-white cursor-pointer transition-colors p-1.5 rounded-lg"
          >
            <Question size={20} />
          </button>

          {/* ── Connect Button ─────────────────────────────────────────── */}
          {!isActuallyConnected ? (
            <div className="relative" ref={dropdownRef}>
              <button
                id="header-connect-wallet-btn"
                onClick={loginWithGoogle}
                type="button"
                disabled={isConnecting}
                className="px-4 py-2 rounded-xl text-xs font-semibold tracking-wider transition-all duration-200 active:scale-95 flex items-center gap-2 bg-[#4E8981]/10 hover:bg-[#4E8981]/20 border border-[#4E8981]/30 text-[#4E8981]"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="5" width="20" height="14" rx="2" />
                  <path d="M16 12h.01" />
                </svg>
                Connect Agent Wallet
              </button>

              {/* Status Indicator (for Circle Challenge/Login flow) */}
              {authStatusMessage && (
                <div className="absolute top-full mt-2 right-0 bg-[#1A1D20] border border-[#2A2F35] rounded-lg px-4 py-2 text-xs text-[#8a8f98] whitespace-nowrap shadow-xl">
                  {authStatusMessage}
                </div>
              )}
            </div>
          ) : (
            /* ── Connected: Account Button Only (opens modal) ────────────────────────── */
            <div className="flex items-center gap-2">
              <button
                id="header-account-btn"
                onClick={() => setModalOpen(true)}
                title="View Fee Wallet details"
                type="button"
                className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold bg-[#4E8981]/10 hover:bg-[#4E8981]/20 border border-[#4E8981]/30 hover:border-[#4E8981]/50 text-[#4E8981] transition-all duration-200 active:scale-95"
              >
                <div className="w-4 h-4 rounded-full bg-[#4E8981]/40 flex items-center justify-center">
                  <span className="text-[8px] font-bold text-[#4E8981]">
                    {shortFeeAddress?.slice(0, 2).toUpperCase() || 'FW'}
                  </span>
                </div>
                {shortFeeAddress}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Wallet Details Modal ─────────────────────────────────────── */}
      {modalOpen && isActuallyConnected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          {/* Modal Backdrop click to close */}
          <div className="absolute inset-0" onClick={() => setModalOpen(false)} />

          <div className="bg-[#131619] border border-[#23272C] rounded-2xl p-6 shadow-2xl w-full max-w-sm relative flex flex-col gap-6 z-10">
            {/* Close Button */}
            <button
              onClick={() => setModalOpen(false)}
              className="absolute top-4 right-4 text-[#8a8f98] hover:text-white transition-colors cursor-pointer"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>

            {/* Modal Title */}
            <div className="flex items-center gap-2 border-b border-[#23272C] pb-3">
              <div className="w-2.5 h-2.5 rounded-full bg-[#4E8981] animate-pulse" />
              <h3 className="font-semibold text-sm text-white tracking-wide">Developer-Controlled Wallet</h3>
            </div>

            {/* Wallet Address section */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-bold text-[#8a8f98] uppercase tracking-wider">Dev-Controlled Wallet Address</span>
              <div className="flex items-center justify-between p-3 bg-[#1A1D20] border border-[#2A2F35] rounded-xl gap-2">
                <span className="font-mono text-xs text-white truncate flex-1">{displayFeeAddress || 'Provisioning...'}</span>
                <button
                  onClick={handleCopy}
                  className="p-1.5 rounded-lg hover:bg-white/5 text-[#8a8f98] hover:text-white transition-colors cursor-pointer flex-shrink-0"
                  title="Copy address"
                >
                  {copied ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4E8981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {/* Balances section (Wallet Balance vs Spending Balance) */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1 p-3 bg-[#1A1D20] border border-[#2A2F35] rounded-xl">
                <span className="text-[9px] font-bold text-[#8a8f98] uppercase tracking-wider">Wallet Balance</span>
                <span className="font-mono text-sm font-bold text-white">{feeWalletBalance} <span className="text-[10px] text-[#8a8f98] font-normal">USDC</span></span>
                <span className="text-[8px] text-[#8a8f98]">On-chain (balanceOf)</span>
              </div>
              <div className="flex flex-col gap-1 p-3 bg-[#1A1D20] border border-[#4E8981]/30 rounded-xl">
                <span className="text-[9px] font-bold text-[#4E8981] uppercase tracking-wider">Spending Balance</span>
                <span className="font-mono text-sm font-bold text-white">{spendingBalance} <span className="text-[10px] text-[#8a8f98] font-normal">USDC</span></span>
                <span className="text-[8px] text-[#8a8f98]">Gateway (task fees)</span>
              </div>
            </div>

            {/* Funding / Deposit Section */}
            <div className="flex flex-col gap-3">
              <div className="flex justify-between items-center">
                <span className="text-[10px] font-bold text-[#8a8f98] uppercase tracking-wider">Deposit &amp; Fund</span>
                <button
                  onClick={() => setShowQr(!showQr)}
                  className="text-[10px] text-[#4E8981] hover:text-[#5fa399] transition-colors"
                >
                  {showQr ? 'Hide QR' : 'Show QR'}
                </button>
              </div>

              {showQr && displayFeeAddress && (
                <div className="flex flex-col items-center justify-center p-3 bg-white rounded-xl mx-auto w-full max-w-[180px] transition-all">
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${displayFeeAddress}`}
                    alt="Wallet QR Code"
                    className="w-[120px] h-[120px]"
                  />
                  <span className="text-[8px] text-gray-500 font-mono mt-1.5 break-all text-center">
                    ARC Testnet USDC
                  </span>
                </div>
              )}

              <div className="text-[11px] text-[#8a8f98] leading-relaxed bg-[#1A1D20]/50 border border-[#2A2F35]/40 rounded-xl p-3">
                Send <span className="text-white font-medium">USDC (ARC Testnet)</span> to this wallet address to fund your fee float.
              </div>
            </div>

            {/* Disconnect Action */}
            <div className="border-t border-[#23272C] pt-4 mt-2">
              <button
                onClick={() => {
                  setModalOpen(false);
                  logout();
                }}
                className="w-full py-2.5 rounded-xl text-xs font-semibold bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 transition-all flex items-center justify-center gap-2 cursor-pointer active:scale-95"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                  <polyline points="16 17 21 12 16 7"></polyline>
                  <line x1="21" y1="12" x2="9" y2="12"></line>
                </svg>
                Disconnect Wallet
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
