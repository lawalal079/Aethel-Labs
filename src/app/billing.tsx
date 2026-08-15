'use client';

import React, { useState, useEffect } from 'react';
import { useApp } from './context';
import { useCircleWallet } from './components/providers/CircleWalletProvider';
import {
  Download, TrendUp, Receipt, MagnifyingGlass, Cpu, Database,
  ArrowUpRight, ArrowDownLeft, Spinner, CheckCircle, Warning, Robot,
  CurrencyCircleDollar, Copy, CheckSquare, Clock,
} from '@phosphor-icons/react';
import { createPublicClient, encodeFunctionData, http, parseAbi, parseUnits, getAddress, type Address, type Chain } from 'viem';

// ─── Contract Addresses & ABIs ────────────────────────────────────────────────
const USDC_ADDRESS = (process.env.NEXT_PUBLIC_USDC_ADDRESS ?? '0x3600000000000000000000000000000000000000') as Address;
const GATEWAY_WALLET_ADDRESS = (process.env.NEXT_PUBLIC_GATEWAY_WALLET_ADDRESS ?? '0x0077777d7EBA4688BDeF3E311b846F25870A19B9') as Address;
const CHAIN_ID = parseInt(process.env.NEXT_PUBLIC_CHAIN_ID ?? '5042002', 10);
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://rpc.testnet.arc.network';

const ERC20_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

const GATEWAY_ABI = parseAbi([
  'function deposit(address token, uint256 amount) external',
  'function availableBalance(address token, address user) view returns (uint256)',
]);

const targetChain: Chain = {
  id: CHAIN_ID,
  name: process.env.NEXT_PUBLIC_CHAIN_NAME ?? 'ARC Testnet',
  nativeCurrency: { name: 'ARC', symbol: 'ARC', decimals: 18 },
  rpcUrls: {
    default: { http: [RPC_URL] },
    public: { http: [RPC_URL] },
  },
};

const publicClient = createPublicClient({
  chain: targetChain,
  transport: http(RPC_URL, { timeout: 6_000 }),
});

// ─── Empty state icon ─────────────────────────────────────────────────────────
const EmptyIcon = ({ size = 24, className = '' }: { size?: number; className?: string }) => (
  <Receipt size={size} className={className} />
);

// ─── USDC coin icon ───────────────────────────────────────────────────────────
const USDCIcon = ({ className = 'w-6 h-6' }: { className?: string }) => (
  <svg viewBox="0 0 32 32" className={`${className} flex-shrink-0`} fill="none" xmlns="http://www.w3.org/2000/svg">
    <g fill="white">
      <path d="M20.022 18.124c0-2.124-1.28-2.852-3.84-3.156-1.828-.243-2.193-.728-2.193-1.578 0-.85.61-1.396 1.828-1.396 1.097 0 1.707.364 2.011 1.275a.458.458 0 00.427.303h.975a.416.416 0 00.427-.425v-.06a3.04 3.04 0 00-2.743-2.489V9.142c0-.243-.183-.425-.487-.486h-.915c-.243 0-.426.182-.487.486v1.396c-1.829.242-2.986 1.456-2.986 2.974 0 2.002 1.218 2.791 3.778 3.095 1.707.303 2.255.668 2.255 1.639 0 .97-.853 1.638-2.011 1.638-1.585 0-2.133-.667-2.316-1.578-.06-.242-.244-.364-.427-.364h-1.036a.416.416 0 00-.426.425v.06c.243 1.518 1.219 2.61 3.23 2.914v1.457c0 .242.183.425.487.485h.915c.243 0 .426-.182.487-.485V21.34c1.829-.303 3.047-1.578 3.047-3.217z" />
      <path d="M12.892 24.497c-4.754-1.7-7.192-6.98-5.424-11.653.914-2.55 2.925-4.491 5.424-5.402.244-.121.365-.303.365-.607v-.85c0-.242-.121-.424-.365-.485-.061 0-.183 0-.244.06a10.895 10.895 0 00-7.13 13.717c1.096 3.4 3.717 6.01 7.13 7.102.244.121.488 0 .548-.243.061-.06.061-.122.061-.243v-.85c0-.182-.182-.424-.365-.546zm6.46-18.936c-.244-.122-.488 0-.548.242-.061.061-.061.122-.061.243v.85c0 .243.182.485.365.607 4.754 1.7 7.192 6.98 5.424 11.653-.914 2.55-2.925 4.491-5.424 5.402-.244.121-.365.303-.365.607v.85c0 .242.121.424.365.485.061 0 .183 0 .244-.06a10.895 10.895 0 007.13-13.717c-1.096-3.46-3.778-6.07-7.13-7.162z" />
    </g>
  </svg>
);

export default function Billing() {
  const { executionLogs, daemonStatus, deployedAgentIds } = useApp();
  const circle = useCircleWallet();

  const [filterQuery, setFilterQuery] = useState('');
  const [tab, setTab] = useState<'deposit' | 'withdraw'>('deposit');
  const [amount, setAmount] = useState('');

  // Processing & notification states (Gateway flows)
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Trading Wallet flow state
  const [twTab, setTwTab] = useState<'fund' | 'withdraw'>('fund');
  const [twAmount, setTwAmount] = useState('');
  const [isTwProcessing, setIsTwProcessing] = useState(false);
  const [twStatusMessage, setTwStatusMessage] = useState<string | null>(null);
  const [twErrorMessage, setTwErrorMessage] = useState<string | null>(null);
  const [twSuccessMessage, setTwSuccessMessage] = useState<string | null>(null);
  // Withdraw confirmation dialog state
  const [showWithdrawConfirm, setShowWithdrawConfirm] = useState(false);
  // Copy-to-clipboard state
  const [copiedAddress, setCopiedAddress] = useState(false);

  const isLoadingLogs = executionLogs === undefined || executionLogs === null;
  const filteredLogs = (executionLogs ?? []).filter((log) =>
    log.agent_name.toLowerCase().includes(filterQuery.toLowerCase())
  );

  const activeAddress: Address | null = circle.walletAddress as Address | null;
  const gatewayBalance = circle.spendingBalance;
  const { tradingWalletAddress, tradingWalletBalance, isTradingWalletProvisioned, feeWalletAddress, feeWalletBalance, isFeeWalletProvisioned, refreshTradingWallet } = circle;
  const [fundTarget, setFundTarget] = useState<'trading' | 'fee'>('trading');
  const [copiedFeeAddress, setCopiedFeeAddress] = useState(false);

  // Export statement modal state
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportRange, setExportRange] = useState<'last_7_days' | 'last_30_days' | 'all_time'>('last_7_days');

  const handleExportCsv = (range: 'last_7_days' | 'last_30_days' | 'all_time') => {
    const now = Date.now();
    const rangeMs = range === 'last_7_days' ? 7 * 86400 * 1000 : range === 'last_30_days' ? 30 * 86400 * 1000 : Infinity;

    const filtered = (executionLogs ?? []).filter(log => {
      if (range === 'all_time') return true;
      try {
        const logTime = new Date(log.timestamp).getTime();
        if (isNaN(logTime)) return false;
        return (now - logTime) <= rangeMs;
      } catch {
        return false;
      }
    });

    const headers = ['Timestamp', 'Transaction Type', 'Agent Name', 'Amount USDC', 'Status', 'Tx Hash'];
    const rows = filtered.map(log => [
      `"${log.timestamp}"`,
      `"${log.tx_type || 'Nanopayment'}"`,
      `"${log.agent_name || ''}"`,
      `"${log.cost_usdc}"`,
      `"${log.status}"`,
      `"${log.tx_hash || ''}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Aethel_Labs_Statement_${range}_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setShowExportModal(false);
  };

  // Withdrawal Destination Selection ('fee' | 'custom')
  const [twWithdrawDestMode, setTwWithdrawDestMode] = useState<'fee' | 'custom'>('fee');
  const [twCustomDestAddress, setTwCustomDestAddress] = useState('');

  // Live Market Price fetching for Portfolio valuation (BTC & EUR)
  const [btcPrice, setBtcPrice] = useState<number>(96500);
  const [eurPrice, setEurPrice] = useState<number>(1.08);

  useEffect(() => {
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,euro&vs_currencies=usd')
      .then(res => res.json())
      .then(data => {
        if (data?.bitcoin?.usd) setBtcPrice(data.bitcoin.usd);
        if (data?.euro?.usd) setEurPrice(data.euro.usd);
      })
      .catch(() => {});
  }, []);

  // Force sync live on-chain Gateway & Trading wallet balances on Billing mount
  useEffect(() => {
    if (circle.walletAddress) {
      void circle.refreshBalance();
      void circle.refreshTradingWallet();
    }
  }, [circle.walletAddress]);

  const shortTwAddress = tradingWalletAddress
    ? `${tradingWalletAddress.slice(0, 8)}...${tradingWalletAddress.slice(-6)}`
    : null;
  const shortFwAddress = feeWalletAddress
    ? `${feeWalletAddress.slice(0, 8)}...${feeWalletAddress.slice(-6)}`
    : null;

  // Helper: Quick non-blocking challenge poll (500ms intervals, 3s max)
  const pollChallengeFast = async (userToken: string, id: string): Promise<void> => {
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const res = await fetch('/api/endpoints', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'getSignature', userToken, id }),
        });
        if (res.ok) {
          const data = await res.json();
          const status = data.state ?? data.status;
          if (status === 'COMPLETE' || status === 'CONFIRMED' || status === 'SUCCESS') return;
        }
      } catch {}
    }
  };

  // ── Copy Trading Wallet / Fee Wallet address to clipboard ─────────────────────
  const handleCopyAddress = () => {
    if (!tradingWalletAddress) return;
    navigator.clipboard.writeText(tradingWalletAddress).then(() => {
      setCopiedAddress(true);
      setTimeout(() => setCopiedAddress(false), 2000);
    }).catch(() => {});
  };

  const handleCopyFeeAddress = () => {
    if (!feeWalletAddress) return;
    navigator.clipboard.writeText(feeWalletAddress).then(() => {
      setCopiedFeeAddress(true);
      setTimeout(() => setCopiedFeeAddress(false), 2000);
    }).catch(() => {});
  };

  // ── Fund Trading Wallet or Fee Wallet ───────────────────────────────────────
  // Simple USDC.transfer from Agent Wallet to Trading Wallet or Fee Wallet address.
  const handleFundWallet = async (target: 'trading' | 'fee') => {
    setTwErrorMessage(null);
    setTwSuccessMessage(null);

    const isFee = target === 'fee';
    const targetAddr = isFee ? feeWalletAddress : tradingWalletAddress;
    const isProvisioned = isFee ? isFeeWalletProvisioned : isTradingWalletProvisioned;
    const walletLabel = isFee ? 'Fee Wallet' : 'Trading Wallet';

    if (!circle.isConnected || !activeAddress) {
      setTwErrorMessage('Please connect your Agent Wallet first.');
      return;
    }
    if (!isProvisioned || !targetAddr) {
      setTwErrorMessage(`No ${walletLabel} provisioned yet. Deploy an agent first.`);
      return;
    }
    const userToken = circle.loginResult?.userToken;
    const walletId = circle.circleWallets?.[0]?.id;
    if (!userToken || !walletId) {
      setTwErrorMessage('Circle wallet session not found. Please log in again.');
      return;
    }
    const parsedAmount = parseFloat(twAmount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      setTwErrorMessage('Please enter a valid amount greater than zero.');
      return;
    }
    if (parsedAmount > parseFloat(feeWalletBalance || '0.00')) {
      setTwErrorMessage(`Insufficient Fee Wallet balance. You have ${feeWalletBalance || '0.00'} USDC available.`);
      return;
    }


    setIsTwProcessing(true);
    try {
      setTwStatusMessage(`Submitting transfer to ${walletLabel}...`);
      const res = await fetch('/api/agents/trading-wallet', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          action: 'fund',
          amount: parsedAmount.toFixed(6),
        }),
      });

      const resData = await res.json();
      if (!res.ok || !resData.success) {
        throw new Error(resData.error ?? 'Funding failed.');
      }

      setTwStatusMessage(`Refreshing ${walletLabel} balance...`);
      await refreshTradingWallet();
      await circle.refreshBalance();

      setTwSuccessMessage(`Successfully funded ${walletLabel} with ${parsedAmount.toFixed(2)} USDC.`);
      setTwAmount('');
    } catch (err: any) {
      console.error(`[billing] Fund ${walletLabel} failed:`, err);
      setTwErrorMessage(err.message ?? 'Transfer failed. Please try again.');
    } finally {
      setIsTwProcessing(false);
      setTwStatusMessage(null);
    }
  };

  // ── Withdraw from Trading Wallet (after confirmation) ───────────────────────
  // Server-initiated transfer from Developer-Controlled Trading Wallet back to user's Agent Wallet.
  const handleWithdrawTradingWallet = async () => {
    setShowWithdrawConfirm(false);
    setTwErrorMessage(null);
    setTwSuccessMessage(null);

    if (!circle.isConnected || !activeAddress) {
      setTwErrorMessage('Please connect your Agent Wallet first.');
      return;
    }
    if (!isTradingWalletProvisioned) {
      setTwErrorMessage('No Trading Wallet provisioned. Nothing to withdraw.');
      return;
    }

    const bearerToken = circle.loginResult?.userToken;
    if (!bearerToken) {
      setTwErrorMessage('Circle session not found. Please log in again.');
      return;
    }

    const parsedAmount = parseFloat(twAmount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      setTwErrorMessage('Please enter a valid amount greater than zero.');
      return;
    }
    if (parsedAmount > parseFloat(tradingWalletBalance)) {
      setTwErrorMessage(`Insufficient Trading Wallet balance. Available: ${tradingWalletBalance} USDC.`);
      return;
    }

    let destinationAddress = feeWalletAddress as string;
    if (twWithdrawDestMode === 'custom') {
      if (!twCustomDestAddress || !/^0x[a-fA-F0-9]{40}$/.test(twCustomDestAddress)) {
        setTwErrorMessage('Please enter a valid custom EVM address (0x...).');
        return;
      }
      destinationAddress = twCustomDestAddress;
    } else {
      if (!feeWalletAddress) {
        setTwErrorMessage('No Fee Wallet provisioned to receive funds.');
        return;
      }
    }

    setIsTwProcessing(true);
    try {
      setTwStatusMessage('Initiating withdrawal from Trading Wallet...');
      const idempotencyKey = crypto.randomUUID();

      const res = await fetch('/api/agents/trading-wallet', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${bearerToken}`,
        },
        body: JSON.stringify({ amount: parsedAmount.toFixed(6), destinationAddress, idempotencyKey }),
      });

      const resData = await res.json();
      if (!res.ok || !resData.success) {
        throw new Error(resData.error ?? 'Withdrawal failed.');
      }

      setTwStatusMessage('Withdrawal submitted. Refreshing balances...');
      await refreshTradingWallet();
      await circle.refreshBalance();

      setTwSuccessMessage(`Withdrawal of ${parsedAmount.toFixed(2)} USDC initiated. Tx ID: ${resData.id ?? resData.txHash ?? 'pending'}.`);
      setTwAmount('');
    } catch (err: any) {
      console.error('[billing] Withdraw from Trading Wallet failed:', err);
      setTwErrorMessage(err.message ?? 'Withdrawal failed. Please try again.');
    } finally {
      setIsTwProcessing(false);
      setTwStatusMessage(null);
    }
  };

  // ── Withdraw from Fee Wallet ─────────────────────────────────────────────────
  const handleWithdrawFeeWallet = async () => {
    setTwErrorMessage(null);
    setTwSuccessMessage(null);

    if (!circle.isConnected || !activeAddress) {
      setTwErrorMessage('Please connect your Agent Wallet first.');
      return;
    }
    if (!isFeeWalletProvisioned) {
      setTwErrorMessage('No Fee Wallet provisioned. Nothing to withdraw.');
      return;
    }

    const bearerToken = circle.loginResult?.userToken;
    if (!bearerToken) {
      setTwErrorMessage('Circle session not found. Please log in again.');
      return;
    }

    const parsedAmount = parseFloat(twAmount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      setTwErrorMessage('Please enter a valid amount greater than zero.');
      return;
    }
    if (parsedAmount > parseFloat(feeWalletBalance)) {
      setTwErrorMessage(`Insufficient Fee Wallet balance. Available: ${feeWalletBalance} USDC.`);
      return;
    }

    let destinationAddress = tradingWalletAddress as string;
    if (twWithdrawDestMode === 'custom') {
      if (!twCustomDestAddress || !/^0x[a-fA-F0-9]{40}$/.test(twCustomDestAddress)) {
        setTwErrorMessage('Please enter a valid custom EVM address (0x...).');
        return;
      }
      destinationAddress = twCustomDestAddress;
    }

    setIsTwProcessing(true);
    try {
      setTwStatusMessage('Initiating withdrawal from Fee Wallet...');
      const idempotencyKey = crypto.randomUUID();

      const res = await fetch('/api/agents/fee-wallet', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${bearerToken}`,
        },
        body: JSON.stringify({ amount: parsedAmount.toFixed(6), destinationAddress, idempotencyKey }),
      });

      const resData = await res.json();
      if (!res.ok || !resData.success) {
        throw new Error(resData.error ?? 'Fee Wallet withdrawal failed.');
      }

      setTwStatusMessage('Withdrawal submitted. Refreshing balances...');
      await circle.refreshBalance();

      setTwSuccessMessage(`Withdrawal of ${parsedAmount.toFixed(2)} USDC initiated from Fee Wallet. Tx ID: ${resData.id ?? resData.txHash ?? 'pending'}.`);
      setTwAmount('');
    } catch (err: any) {
      console.error('[billing] Withdraw from Fee Wallet failed:', err);
      setTwErrorMessage(err.message ?? 'Fee Wallet withdrawal failed. Please try again.');
    } finally {
      setIsTwProcessing(false);
      setTwStatusMessage(null);
    }
  };

  // ── Withdraw from Gateway ────────────────────────────────────────────────────
  const handleWithdrawGateway = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);

    const userAddress = activeAddress || circle.feeWalletAddress;
    if (!circle.isConnected || !userAddress) {
      setErrorMessage('Please connect your Agent Wallet first.');
      return;
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      setErrorMessage('Please enter a valid amount greater than zero.');
      return;
    }
    if (parsedAmount > parseFloat(gatewayBalance || '0.00')) {
      setErrorMessage(`Insufficient Gateway balance. Available: ${gatewayBalance || '0.00'} USDC.`);
      return;
    }

    setIsProcessing(true);
    try {
      setStatusMessage('Submitting Circle Gateway Burn Intent via Fee Wallet...');
      const submitRes = await fetch('/api/gateway-withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userAddress,
          amountUsdc: parsedAmount.toFixed(6),
        }),
      });

      const submitData = await submitRes.json();
      if (!submitRes.ok || !submitData.transferId) {
        throw new Error(submitData.error ?? 'Gateway withdrawal submission failed.');
      }

      // Optimistically deduct Gateway spending balance immediately in UI state
      if (circle.setSpendingBalance) {
        circle.setSpendingBalance(prev => Math.max(0, parseFloat(prev || '0') - parsedAmount).toFixed(6));
      }

      setStatusMessage('Burn Intent accepted by Gateway Forwarder. Refreshing balance...');
      await circle.refreshBalance();

      setSuccessMessage(`Gateway withdrawal of ${parsedAmount.toFixed(2)} USDC submitted! Circle Gateway Forwarder is minting USDC to your wallet (typically completes in ~30 seconds). Transfer ID: ${submitData.transferId}`);
      setAmount('');
    } catch (err: any) {
      console.error('[billing] Gateway withdrawal failed:', err);
      setErrorMessage(err.message ?? 'Gateway withdrawal failed. Please try again.');
    } finally {
      setIsProcessing(false);
      setStatusMessage(null);
    }
  };

  // Direct, fast Gateway deposit flow: approve (if needed) + deposit
  const handleDepositSubmit = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);

    if (!circle.isConnected || !activeAddress) {
      setErrorMessage('Please connect your Agent Wallet first.');
      return;
    }

    const userToken = circle.loginResult?.userToken;
    if (!userToken) {
      setErrorMessage('Circle wallet session not found. Please log in again.');
      return;
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      setErrorMessage('Please enter a valid deposit amount greater than zero.');
      return;
    }

    const walletBalNum = parseFloat(feeWalletBalance || '0.00');
    if (parsedAmount > walletBalNum) {
      setErrorMessage(
        `Insufficient Fee Wallet USDC balance. You have ${feeWalletBalance || '0.00'} USDC available on-chain.`
      );
      return;
    }

    setIsProcessing(true);

    try {
      // Server-side: ENGINE Fee Wallet executes approve() + deposit() via entity-secret.
      // No browser popup, no circle.executeChallenge — fully server-driven.
      setStatusMessage('Submitting deposit to Gateway (server-side)...');

      const depositRes = await fetch('/api/agents/gateway-deposit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ amountUsdc: parsedAmount.toFixed(6) }),
      });

      const depositData = await depositRes.json();
      if (!depositRes.ok || !depositData.success) {
        throw new Error(depositData.error ?? 'Gateway deposit failed.');
      }

      // Auto-record deposit to transaction ledger
      try {
        await fetch('/api/agents/transactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userAddress: activeAddress,
            agentId: 'circle_gateway_deposit',
            agentName: 'Circle Gateway Deposit',
            txType: 'Deposit',
            amountUsdc: parsedAmount,
            status: 'SUCCESS',
            txHash: depositData.depositTxHash || depositData.txHash || `tx_${Date.now()}`,
            timestamp: new Date().toISOString(),
          }),
        });
      } catch { /* ignore */ }

      setStatusMessage('Refreshing balances...');
      await circle.refreshBalance();

      setSuccessMessage(`Successfully deposited ${parsedAmount.toFixed(2)} USDC into Gateway!`);
      setAmount('');
    } catch (err: any) {
      console.error('[billing] Deposit failed:', err);
      setErrorMessage(err.message ?? 'Gateway deposit failed. Please try again.');
    } finally {
      setIsProcessing(false);
      setStatusMessage(null);
    }
  };

  const handleAction = (e: React.FormEvent) => {
    e.preventDefault();
    if (tab === 'deposit') {
      void handleDepositSubmit();
    } else {
      void handleWithdrawGateway();
    }
  };

  // ── Real Daily Spend & Consumption Rate Calculation ─────────────────────────
  const todayStr = new Date().toISOString().split('T')[0];
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterdayStr = yesterdayDate.toISOString().split('T')[0];

  let todayLogsSpend = 0;
  let yesterdayLogsSpend = 0;

  (executionLogs ?? []).forEach(log => {
    if (log.tx_type === 'Nanopayment' || (log.cost_usdc && log.cost_usdc > 0)) {
      try {
        const parsed = new Date(log.timestamp);
        if (isNaN(parsed.getTime())) return;
        const logDate = parsed.toISOString().split('T')[0];
        if (logDate === todayStr) {
          todayLogsSpend += Math.abs(log.cost_usdc);
        } else if (logDate === yesterdayStr) {
          yesterdayLogsSpend += Math.abs(log.cost_usdc);
        }
      } catch {
        // Skip entries with unparseable timestamps
      }
    }
  });

  const activeAgentCount = daemonStatus?.running ? Math.max(1, deployedAgentIds?.length || 1) : 0;
  const isDaemonRunning = activeAgentCount > 0;
  const daemonInterval = daemonStatus?.intervalSeconds || 60;
  const activeDailyBurn = isDaemonRunning ? activeAgentCount * (86400 / daemonInterval) * 0.0001 : 0;
  const daemonCycleSpendToday = (daemonStatus?.cycleCount || 0) * 0.0001;
  const todaySpend = isDaemonRunning ? Math.max(activeDailyBurn, daemonCycleSpendToday + todayLogsSpend) : (daemonCycleSpendToday + todayLogsSpend);

  let dodChange = 0;
  let isIncrease = true;
  if (yesterdayLogsSpend > 0) {
    dodChange = ((todaySpend - yesterdayLogsSpend) / yesterdayLogsSpend) * 100;
    isIncrease = dodChange >= 0;
  } else if (todaySpend > 0) {
    dodChange = 100;
    isIncrease = true;
  }

  const currentGatewayBal = parseFloat(gatewayBalance || '0');
  const availableCycles = Math.floor(currentGatewayBal / 0.0001);
  let depletionText = '';
  if (isDaemonRunning && activeDailyBurn > 0 && currentGatewayBal > 0) {
    const days = currentGatewayBal / activeDailyBurn;
    const cyclesPerAgent = Math.floor(availableCycles / activeAgentCount);
    const timeStr = days < (1 / 24)
      ? `${Math.max(1, Math.round(days * 1440))}m`
      : days < 1
        ? `${(days * 24).toFixed(1)}h`
        : `${days.toFixed(1)}d`;

    if (activeAgentCount > 1) {
      depletionText = `~${timeStr} (${cyclesPerAgent} cycles/agent across ${activeAgentCount} agents)`;
    } else {
      depletionText = `~${timeStr} (~${cyclesPerAgent} cycles)`;
    }
  } else if (currentGatewayBal > 0) {
    depletionText = `${availableCycles} cycles in reserve (All agents paused)`;
  } else {
    depletionText = '0 cycles in reserve (Deposit on right to activate)';
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <h2 className="text-3xl font-bold text-white mb-1 tracking-tight font-sans">Billing Hub</h2>
          <p className="text-[#8a8f98] text-sm">Manage your decentralized compute credits and Gateway balances.</p>
        </div>
        <button
          onClick={() => setShowExportModal(true)}
          className="flex items-center gap-2 border border-[#2A2F35] text-white bg-[#1A1D20] hover:bg-[#4E8981]/10 hover:border-[#4E8981]/50 px-4 py-2 rounded-xl text-xs font-semibold transition-all cursor-pointer active:scale-95"
        >
          <Download size={16} />
          Export Statement
        </button>
      </div>

      {/* CSV Export Range Modal */}
      {showExportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-[#131619] border border-[#23272C] rounded-2xl p-6 shadow-2xl w-full max-w-md flex flex-col gap-5 relative">
            <div className="flex justify-between items-center border-b border-[#23272C] pb-3">
              <h3 className="font-semibold text-sm text-white tracking-wide">Export Billing Statement</h3>
              <button onClick={() => setShowExportModal(false)} className="text-[#8a8f98] hover:text-white transition-colors">
                <Warning size={18} className="hidden" /> ✕
              </button>
            </div>
            <p className="text-xs text-[#8a8f98]">
              Select date range for your transaction and nanopayment settlement statement CSV:
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => setExportRange('last_7_days')}
                className={`p-3 rounded-xl border text-xs font-medium text-left flex justify-between items-center ${
                  exportRange === 'last_7_days' ? 'border-[#4E8981] bg-[#4E8981]/10 text-white' : 'border-[#2A2F35] text-[#8a8f98]'
                }`}
              >
                <span>Last 7 Days (Default)</span>
                {exportRange === 'last_7_days' && <CheckCircle size={16} className="text-[#4E8981]" />}
              </button>
              <button
                onClick={() => setExportRange('last_30_days')}
                className={`p-3 rounded-xl border text-xs font-medium text-left flex justify-between items-center ${
                  exportRange === 'last_30_days' ? 'border-[#4E8981] bg-[#4E8981]/10 text-white' : 'border-[#2A2F35] text-[#8a8f98]'
                }`}
              >
                <span>Last 30 Days</span>
                {exportRange === 'last_30_days' && <CheckCircle size={16} className="text-[#4E8981]" />}
              </button>
              <button
                onClick={() => setExportRange('all_time')}
                className={`p-3 rounded-xl border text-xs font-medium text-left flex justify-between items-center ${
                  exportRange === 'all_time' ? 'border-[#4E8981] bg-[#4E8981]/10 text-white' : 'border-[#2A2F35] text-[#8a8f98]'
                }`}
              >
                <span>All Time</span>
                {exportRange === 'all_time' && <CheckCircle size={16} className="text-[#4E8981]" />}
              </button>
            </div>
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setShowExportModal(false)}
                className="flex-1 py-2.5 border border-[#2A2F35] text-[#8a8f98] rounded-xl text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={() => handleExportCsv(exportRange)}
                className="flex-1 py-2.5 border border-[#4E8981] bg-[#4E8981]/20 text-[#4E8981] hover:text-white rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5"
              >
                <Download size={14} /> Download CSV
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bento Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">

        {/* ── LEFT CARD: Gateway Balance (left) | vertical divider | Consumption Rate (right) ── */}
        <div className="lg:col-span-8 bg-[#1A1D20] rounded-xl p-8 border border-[#2A2F35]">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_1px_1fr] gap-0 h-full">

            {/* Gateway Balance */}
            <div className="md:pr-8 flex flex-col justify-between">
              <div>
                <div className="flex justify-between items-start mb-8">
                  <div className="flex items-center gap-2 px-3 py-1 bg-[#4E8981]/10 text-[#4E8981] rounded-full border border-[#4E8981]/20">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#4E8981] animate-pulse" />
                    <span className="text-[10px] font-bold uppercase tracking-wider">Gateway Balance</span>
                  </div>
                  <div className="flex items-center gap-1.5 bg-[#0B0B0C] p-1.5 rounded-lg border border-[#2A2F35]">
                    <USDCIcon className="w-6 h-6" />
                    <span className="text-white font-bold text-xs pr-1">USDC</span>
                  </div>
                </div>
                <p className="text-[10px] font-bold text-[#8a8f98] uppercase tracking-wider mb-1">
                  Available Gateway Balance
                </p>
                <div className="flex items-end gap-3 mb-2">
                  <h3 className="text-5xl md:text-6xl font-bold text-white tracking-tight font-sans">
                    {activeAddress ? gatewayBalance : '—'}
                    <span className="text-2xl text-[#8a8f98] font-medium ml-2">USDC</span>
                  </h3>
                </div>
                <p className="text-[11px] text-[#8a8f98]">
                  Available balance in Circle Gateway used for agent task nanopayments.
                </p>
              </div>
            </div>

            {/* Vertical divider */}
            <div className="hidden md:block bg-[#2A2F35] mx-0" />

            {/* Compute Burn Rate */}
            <div className="md:pl-8 flex flex-col justify-between mt-6 md:mt-0">
              <div className="flex justify-between items-center mb-4">
                <p className="text-[10px] font-bold text-[#8a8f98] uppercase tracking-wider">Compute Burn Rate</p>
                {activeAgentCount > 0 ? (
                  <span className="text-[9px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-emerald-950/40 border border-emerald-800/40 text-emerald-400">
                    {activeAgentCount === 1 ? '1 Active' : `${activeAgentCount} Active`}
                  </span>
                ) : (
                  <span className="text-[9px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-slate-900/60 border border-slate-700/50 text-[#8a8f98]">
                    Idle
                  </span>
                )}
              </div>
              <div className="space-y-4">
                <div className="flex justify-between items-end">
                  <p className="text-white text-2xl font-bold tracking-tight">
                    ${todaySpend.toFixed(4)}<span className="text-xs font-medium text-[#8a8f98]">/day</span>
                  </p>
                  <span className={`text-xs font-bold flex items-center gap-0.5 px-2 py-0.5 rounded-full ${
                    isIncrease
                      ? 'text-emerald-400 bg-emerald-950/30 border border-emerald-900/30'
                      : 'text-sky-400 bg-sky-950/30 border border-sky-900/30'
                  }`}>
                    <TrendUp size={12} className={isIncrease ? '' : 'rotate-180'} />
                    {Math.abs(dodChange).toFixed(1)}%
                  </span>
                </div>
                <div className="w-full bg-[#0B0B0C] h-2 rounded-full overflow-hidden">
                  <div className="bg-[#4E8981] h-full rounded-full" style={{ width: `${Math.min(100, Math.max(10, todaySpend * 500))}%` }} />
                </div>
                <p className="text-[11px] text-[#8a8f98] leading-relaxed">
                  Based on current agent throughput, your balance will last approx. <span className="text-white font-semibold">{depletionText}</span>.
                </p>
              </div>
            </div>

          </div>
        </div>

        {/* ── RIGHT CARD: Deposit & Withdraw ── */}
        <div className="lg:col-span-4 bg-[#1A1D20] rounded-xl p-6 border border-[#2A2F35] flex flex-col gap-6">

          {/* Tabs — ghost style */}
          <div className="flex gap-3">
            <button
              onClick={() => {
                setTab('deposit');
                setErrorMessage(null);
                setSuccessMessage(null);
              }}
              disabled={isProcessing}
              className={`flex-1 py-2.5 text-xs font-bold rounded-xl border bg-transparent transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                tab === 'deposit'
                  ? 'border-[#4E8981] text-[#4E8981]'
                  : 'border-[#2A2F35] text-[#8a8f98] hover:border-[#4E8981]/50 hover:text-white'
              }`}
            >
              <ArrowDownLeft size={14} /> Deposit
            </button>
            <button
              onClick={() => {
                setTab('withdraw');
                setErrorMessage(null);
                setSuccessMessage(null);
              }}
              disabled={isProcessing}
              className={`flex-1 py-2.5 text-xs font-bold rounded-xl border bg-transparent transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                tab === 'withdraw'
                  ? 'border-[#4E8981] text-[#4E8981]'
                  : 'border-[#2A2F35] text-[#8a8f98] hover:border-[#4E8981]/50 hover:text-white'
              }`}
            >
              <ArrowUpRight size={14} /> Withdraw
            </button>
          </div>

          {/* Form / Withdraw Coming Soon */}
          {tab === 'withdraw' ? (
            <div className="flex flex-col items-center justify-center p-6 text-center bg-[#0B0B0C] rounded-xl border border-dashed border-[#4E8981]/30 my-auto min-h-[220px]">
              <div className="w-12 h-12 rounded-full bg-[#4E8981]/10 border border-[#4E8981]/20 flex items-center justify-center mb-3">
                <Clock size={24} className="text-[#4E8981]" />
              </div>
              <h4 className="text-sm font-bold text-white mb-1">Gateway Withdrawals Coming Soon</h4>
              <p className="text-xs text-[#8a8f98] max-w-xs leading-relaxed">
                Circle Gateway cross-chain withdrawals will be enabled in an upcoming release. Your Gateway balance remains 100% active and spendable for agent task fees.
              </p>
            </div>
          ) : (
            <form onSubmit={handleAction} className="flex flex-col gap-4">
              <div>
                <label className="text-[10px] font-bold text-[#8a8f98] uppercase tracking-wider block mb-1.5">
                  Deposit to Gateway
                </label>
                <div className="relative">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={amount}
                    disabled={isProcessing}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === '' || /^\d*\.?\d*$/.test(v)) setAmount(v);
                    }}
                    placeholder="0.00"
                    className="w-full pl-4 pr-16 py-3 bg-[#0B0B0C] border border-[#2A2F35] rounded-xl text-white text-sm font-mono focus:outline-none focus:border-[#4E8981] transition-colors disabled:opacity-50"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-[#8a8f98]">USDC</span>
                </div>
              </div>

              {/* Available balance hint + MAX shortcut */}
              <div className="flex justify-between items-center px-1">
                <span className="text-[10px] text-[#8a8f98]">
                  Available to deposit:
                  {' '}
                  <span className="text-white font-mono font-semibold">
                    {activeAddress ? (feeWalletBalance || '0.00') : '0.00'}
                    {' '}USDC
                  </span>
                </span>
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => setAmount(activeAddress ? (feeWalletBalance || '0.00') : '0.00')}
                  className="text-[10px] font-bold text-[#4E8981] hover:text-white transition-colors cursor-pointer uppercase tracking-wider disabled:opacity-50"
                >
                  MAX
                </button>
              </div>

              {/* Feedback messages */}
              {statusMessage && (
                <div className="p-3 bg-[#4E8981]/10 border border-[#4E8981]/30 rounded-xl flex items-center gap-2 text-xs text-[#4E8981]">
                  <Spinner size={16} className="animate-spin flex-shrink-0" />
                  <span className="leading-snug">{statusMessage}</span>
                </div>
              )}

              {errorMessage && (
                <div className="p-3 bg-rose-950/30 border border-rose-900/30 rounded-xl flex items-start gap-2 text-xs text-rose-400">
                  <Warning size={16} className="flex-shrink-0 mt-0.5" />
                  <span className="leading-snug">{errorMessage}</span>
                </div>
              )}

              {successMessage && (
                <div className="p-3 bg-emerald-950/30 border border-emerald-900/30 rounded-xl flex items-start gap-2 text-xs text-emerald-400">
                  <CheckCircle size={16} className="flex-shrink-0 mt-0.5" />
                  <span className="leading-snug">{successMessage}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={isProcessing}
                className="w-full py-3 bg-transparent border border-[#4E8981] text-[#4E8981] hover:border-[#5fa399] hover:text-white rounded-xl text-xs font-bold transition-all cursor-pointer active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isProcessing && <Spinner size={14} className="animate-spin" />}
                {isProcessing ? 'Processing Deposit...' : 'Deposit Funds'}
              </button>
            </form>
          )}

        </div>

      </div>

      {/* ═══════════════════════════════════════════════════════════════════
           TRADING WALLET SECTION
           Visually distinct from Gateway (indigo/blue instead of teal)
           Per AETHEL_LABS_ROADMAP.md, 2026-07-25: two distinct wallets,
           never blurred into one balance.
      ═══════════════════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">

        {/* ── LEFT: Trading Wallet Status Card ── */}
        <div className="lg:col-span-8 bg-[#1A1D20] rounded-xl p-8 border border-[#3b82f6]/30">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_1px_1fr] gap-0 h-full">

            {/* Address & Balance */}
            <div className="md:pr-8 flex flex-col justify-between">
              <div>
                <div className="flex justify-between items-start mb-8">
                  <div className="flex items-center gap-2 px-3 py-1 bg-[#4E8981]/10 text-[#5fa399] rounded-full border border-[#4E8981]/20">
                    <Robot size={12} weight="bold" />
                    <span className="text-[10px] font-bold uppercase tracking-wider">Trading Wallet</span>
                  </div>
                  <div className="flex items-center gap-1.5 bg-[#0B0B0C] p-1.5 rounded-lg border border-[#2A2F35]">
                    <USDCIcon className="w-6 h-6" />
                    <span className="text-white font-bold text-xs pr-1">USDC</span>
                  </div>
                </div>

                {isTradingWalletProvisioned ? (
                  (() => {
                    const holdings = circle.tradingWalletHoldings || [];
                    const usdcNum = parseFloat(holdings.find(h => h.symbol === 'USDC')?.balance || tradingWalletBalance || '0');
                    const eurcNum = parseFloat(holdings.find(h => h.symbol === 'EURC')?.balance || '0');
                    const cirbtcNum = parseFloat(holdings.find(h => h.symbol === 'cirBTC')?.balance || '0');

                    // Sum total combined portfolio value in USD using live market prices
                    const totalPortfolioValue = usdcNum + (eurcNum * eurPrice) + (cirbtcNum * btcPrice);

                    const usdcBalStr = holdings.find(h => h.symbol === 'USDC')?.balance || tradingWalletBalance;
                    const eurcBalStr = holdings.find(h => h.symbol === 'EURC')?.balance || '0.000000';
                    const cirbtcBalStr = holdings.find(h => h.symbol === 'cirBTC')?.balance || '0.00000000';

                    return (
                      <>
                        <p className="text-[10px] font-bold text-[#8a8f98] uppercase tracking-wider mb-1">
                          Trading Wallet Balance
                        </p>
                        <div className="flex items-end gap-3 mb-4">
                          <h3 className="text-5xl md:text-6xl font-bold text-white tracking-tight font-sans">
                            ${totalPortfolioValue.toFixed(2)}
                            <span className="text-2xl text-[#8a8f98] font-medium ml-2">USD</span>
                          </h3>
                        </div>

                        <p className="text-[10px] font-bold text-[#8a8f98] uppercase tracking-wider mb-1 mt-4">
                          Wallet Address
                        </p>
                        <div className="flex items-center gap-2">
                          <code className="text-xs text-[#5fa399] font-mono bg-[#0B0B0C] px-3 py-1.5 rounded-lg border border-[#4E8981]/20 flex-1 truncate">
                            {shortTwAddress}
                          </code>
                          <button
                            id="billing-copy-trading-wallet-address"
                            onClick={handleCopyAddress}
                            title="Copy full address"
                            className="p-1.5 rounded-lg bg-[#0B0B0C] border border-[#4E8981]/20 text-[#5fa399] hover:text-white hover:border-[#4E8981]/50 transition-colors cursor-pointer"
                          >
                            {copiedAddress ? <CheckSquare size={14} /> : <Copy size={14} />}
                          </button>
                        </div>

                        {/* Multi-Token Holdings Breakdown (USDC, EURC, cirBTC) */}
                        <div className="mt-4 pt-3 border-t border-[#2A2F35] space-y-2">
                          <p className="text-[10px] font-bold text-[#8a8f98] uppercase tracking-wider">
                            Asset Holdings Breakdown (Arc Testnet)
                          </p>
                          <div className="bg-[#0B0B0C] rounded-xl border border-[#2A2F35] overflow-hidden divide-y divide-[#2A2F35]/40 font-mono text-xs">
                            <div className="flex items-center justify-between p-2.5 hover:bg-[#16191C]/40">
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-blue-400" />
                                <span className="font-bold text-white">USDC</span>
                                <span className="text-[10px] text-[#8a8f98]">USD Coin</span>
                              </div>
                              <span className="font-bold text-white">{usdcBalStr} USDC</span>
                            </div>
                            <div className="flex items-center justify-between p-2.5 hover:bg-[#16191C]/40">
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-indigo-400" />
                                <span className="font-bold text-white">EURC</span>
                                <span className="text-[10px] text-[#8a8f98]">Euro Coin</span>
                              </div>
                              <span className="font-bold text-indigo-300">{eurcBalStr} EURC</span>
                            </div>
                            <div className="flex items-center justify-between p-2.5 hover:bg-[#16191C]/40">
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-amber-400" />
                                <span className="font-bold text-white">cirBTC</span>
                                <span className="text-[10px] text-[#8a8f98]">Circle Wrapped BTC</span>
                              </div>
                              <span className="font-bold text-amber-300">{cirbtcBalStr} cirBTC</span>
                            </div>
                          </div>
                        </div>
                      </>
                    );
                  })()
                ) : (
                  <>
                    <p className="text-[10px] font-bold text-[#8a8f98] uppercase tracking-wider mb-2">
                      Not Yet Provisioned
                    </p>
                    <div className="flex items-center gap-3 p-4 bg-[#0B0B0C] rounded-xl border border-dashed border-[#4E8981]/20">
                      <Robot size={24} className="text-[#4E8981]/40 flex-shrink-0" />
                      <p className="text-xs text-[#8a8f98] leading-relaxed">
                        Deploy a trading agent to provision your Trading Wallet. Once deployed, your agent will execute autonomous swaps from this wallet.
                      </p>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Vertical divider */}
            <div className="hidden md:block bg-[#2A2F35] mx-0" />

            {/* Explanation / Fee Wallet display */}
            <div className="md:pl-8 flex flex-col justify-between mt-6 md:mt-0">
              <div>
                <p className="text-[10px] font-bold text-[#8a8f98] uppercase tracking-wider mb-4">Fee Wallet (Task Fees Float)</p>
                {isFeeWalletProvisioned ? (
                  <div className="p-3 bg-[#0B0B0C] rounded-xl border border-[#4E8981]/20 mb-4 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-[10px] text-[#8a8f98] font-bold uppercase">Gateway Spendable Float</span>
                      <span className="text-xs font-mono font-bold text-emerald-400">{gatewayBalance} USDC</span>
                    </div>
                    <div className="flex justify-between items-center pt-1 border-t border-[#1A1D20]">
                      <span className="text-[10px] text-[#8a8f98]">Est. Cycles Remaining</span>
                      <span className="text-xs font-mono text-white">{Math.floor(parseFloat(gatewayBalance || '0') / 0.0001)} cycles</span>
                    </div>
                    <div className="flex items-center gap-1.5 pt-2 border-t border-[#2A2F35]">
                      <code className="text-[10px] text-[#5fa399] font-mono flex-1 truncate">{shortFwAddress}</code>
                      <button
                        onClick={handleCopyFeeAddress}
                        className="p-1 rounded bg-[#1A1D20] text-[#5fa399] hover:text-white transition-colors"
                        title="Copy Fee Wallet address"
                      >
                        {copiedFeeAddress ? <CheckSquare size={12} /> : <Copy size={12} />}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="p-3 bg-[#0B0B0C] rounded-xl border border-dashed border-[#2A2F35] mb-4 text-xs text-[#8a8f98]">
                    Fee Wallet provisions automatically when an agent is deployed.
                  </div>
                )}

                <p className="text-[10px] font-bold text-[#8a8f98] uppercase tracking-wider mb-3">About Platform Wallets</p>
                <div className="space-y-3">
                  <div className="flex items-start gap-2.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#4E8981] mt-1.5 flex-shrink-0" />
                    <p className="text-xs text-[#8a8f98] leading-relaxed">
                      <span className="text-white font-semibold">Trading Wallet:</span> Holds trading principal for autonomous USDC/EURC swaps.
                    </p>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mt-1.5 flex-shrink-0" />
                    <p className="text-xs text-[#8a8f98] leading-relaxed">
                      <span className="text-white font-semibold">Fee Wallet:</span> Pays $0.0001 USDC task fee per daemon cycle tick. Completely separate from trading capital.
                    </p>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>

        {/* ── RIGHT: Fund / Withdraw Trading Wallet ── */}
        <div className="lg:col-span-4 bg-[#1A1D20] rounded-xl p-6 border border-[#4E8981]/30 flex flex-col gap-6">

          <div className="flex gap-3">
            <button
              id="billing-tw-tab-fund"
              onClick={() => { setTwTab('fund'); setTwErrorMessage(null); setTwSuccessMessage(null); }}
              disabled={isTwProcessing}
              className={`flex-1 py-2.5 text-xs font-bold rounded-xl border bg-transparent transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                twTab === 'fund'
                  ? 'border-[#4E8981] text-[#5fa399] bg-[#4E8981]/10'
                  : 'border-[#2A2F35] text-[#8a8f98] hover:border-[#4E8981]/50 hover:text-white'
              }`}
            >
              <ArrowDownLeft size={14} /> Fund
            </button>
            <button
              id="billing-tw-tab-withdraw"
              onClick={() => { setTwTab('withdraw'); setTwErrorMessage(null); setTwSuccessMessage(null); }}
              disabled={isTwProcessing}
              className={`flex-1 py-2.5 text-xs font-bold rounded-xl border bg-transparent transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                twTab === 'withdraw'
                  ? 'border-[#4E8981] text-[#5fa399] bg-[#4E8981]/10'
                  : 'border-[#2A2F35] text-[#8a8f98] hover:border-[#4E8981]/50 hover:text-white'
              }`}
            >
              <ArrowUpRight size={14} /> Withdraw
            </button>
          </div>

          <div className="flex flex-col gap-4">
            <div>
              <label className="text-[10px] font-bold text-[#8a8f98] uppercase tracking-wider block mb-1.5">
                {twTab === 'fund' ? 'Fund Trading Wallet' : 'Withdraw from Trading Wallet'}
              </label>
              <div className="relative">
                <input
                  id={`billing-tw-amount-${twTab}`}
                  type="text"
                  inputMode="decimal"
                  value={twAmount}
                  disabled={isTwProcessing}
                  onChange={(e) => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setTwAmount(v); }}
                  placeholder={twTab === 'fund' && fundTarget === 'fee' ? '0.10' : '0.00'}
                  className="w-full pl-4 pr-16 py-3 bg-[#0B0B0C] border border-[#2A2F35] rounded-xl text-white text-sm font-mono focus:outline-none focus:border-[#4E8981] transition-colors disabled:opacity-50"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-[#8a8f98]">USDC</span>
              </div>
            </div>

            <div className="flex justify-between items-center px-1">
              <span className="text-[10px] text-[#8a8f98]">
                {twTab === 'fund' ? 'Current Trading Wallet Balance' : 'Available to withdraw'}:
                <span className="text-white font-mono font-semibold ml-1">
                  {tradingWalletBalance} USDC
                </span>
              </span>
              <button
                type="button"
                disabled={isTwProcessing}
                onClick={() => setTwAmount(tradingWalletBalance)}
                className="text-[10px] font-bold text-[#5fa399] hover:text-white transition-colors cursor-pointer uppercase tracking-wider disabled:opacity-50"
              >MAX</button>
            </div>

            {twTab === 'withdraw' && (
              <div className="space-y-2 pt-1">
                <label className="text-[10px] font-bold text-[#8a8f98] uppercase tracking-wider block">
                  Withdrawal Destination
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={isTwProcessing}
                    onClick={() => setTwWithdrawDestMode('fee')}
                    className={`py-2 px-2 rounded-xl text-xs font-bold border transition-colors cursor-pointer disabled:opacity-50 ${
                      twWithdrawDestMode === 'fee'
                        ? 'bg-[#4E8981]/20 border-[#4E8981] text-[#5fa399]'
                        : 'bg-[#0B0B0C] border-[#2A2F35] text-[#8a8f98] hover:text-white'
                    }`}
                  >
                    Fee Wallet
                  </button>
                  <button
                    type="button"
                    disabled={isTwProcessing}
                    onClick={() => setTwWithdrawDestMode('custom')}
                    className={`py-2 px-2 rounded-xl text-xs font-bold border transition-colors cursor-pointer disabled:opacity-50 ${
                      twWithdrawDestMode === 'custom'
                        ? 'bg-[#4E8981]/20 border-[#4E8981] text-[#5fa399]'
                        : 'bg-[#0B0B0C] border-[#2A2F35] text-[#8a8f98] hover:text-white'
                    }`}
                  >
                    Custom Addr
                  </button>
                </div>

                {twWithdrawDestMode === 'custom' && (
                  <input
                    type="text"
                    value={twCustomDestAddress}
                    disabled={isTwProcessing}
                    onChange={(e) => setTwCustomDestAddress(e.target.value)}
                    placeholder="Recipient EVM address (0x...)"
                    className="w-full pl-3 pr-3 py-2 bg-[#0B0B0C] border border-[#2A2F35] rounded-xl text-white text-xs font-mono focus:outline-none focus:border-[#4E8981]"
                  />
                )}
              </div>
            )}

            {/* Feedback */}
            {twStatusMessage && (
              <div className="p-3 bg-[#4E8981]/10 border border-[#4E8981]/30 rounded-xl flex items-center gap-2 text-xs text-[#5fa399]">
                <Spinner size={16} className="animate-spin flex-shrink-0" />
                <span className="leading-snug">{twStatusMessage}</span>
              </div>
            )}
            {twErrorMessage && (
              <div className="p-3 bg-rose-950/30 border border-rose-900/30 rounded-xl flex items-start gap-2 text-xs text-rose-400">
                <Warning size={16} className="flex-shrink-0 mt-0.5" />
                <span className="leading-snug">{twErrorMessage}</span>
              </div>
            )}
            {twSuccessMessage && (
              <div className="p-3 bg-emerald-950/30 border border-emerald-900/30 rounded-xl flex items-start gap-2 text-xs text-emerald-400">
                <CheckCircle size={16} className="flex-shrink-0 mt-0.5" />
                <span className="leading-snug">{twSuccessMessage}</span>
              </div>
            )}

            {twTab === 'fund' ? (
              <button
                id="billing-tw-fund-submit"
                type="button"
                disabled={isTwProcessing || !isTradingWalletProvisioned}
                onClick={() => { void handleFundWallet('trading'); }}
                className="w-full py-3 bg-transparent border border-[#4E8981] text-[#5fa399] hover:border-[#5fa399] hover:text-white rounded-xl text-xs font-bold transition-all cursor-pointer active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isTwProcessing && <Spinner size={14} className="animate-spin" />}
                {isTwProcessing ? 'Processing...' : 'Fund Trading Wallet'}
              </button>
            ) : (
              <button
                id="billing-tw-withdraw-open-confirm"
                type="button"
                disabled={isTwProcessing || !isTradingWalletProvisioned}
                onClick={() => {
                  setTwErrorMessage(null);
                  setTwSuccessMessage(null);
                  const v = parseFloat(twAmount);
                  if (isNaN(v) || v <= 0) { setTwErrorMessage('Enter a valid amount first.'); return; }
                  if (v > parseFloat(tradingWalletBalance)) { setTwErrorMessage(`Insufficient Trading Wallet balance (${tradingWalletBalance} USDC available).`); return; }
                  if (twWithdrawDestMode === 'custom' && (!twCustomDestAddress || !/^0x[a-fA-F0-9]{40}$/.test(twCustomDestAddress))) {
                    setTwErrorMessage('Please enter a valid 0x... destination EVM address.');
                    return;
                  }
                  setShowWithdrawConfirm(true);
                }}
                className="w-full py-3 bg-transparent border border-[#4E8981] text-[#5fa399] hover:border-[#5fa399] hover:text-white rounded-xl text-xs font-bold transition-all cursor-pointer active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isTwProcessing && <Spinner size={14} className="animate-spin" />}
                {isTwProcessing
                  ? 'Processing...'
                  : twWithdrawDestMode === 'fee'
                  ? 'Withdraw to Fee Wallet'
                  : 'Withdraw to Custom Address'}
              </button>
            )}

            {!isTradingWalletProvisioned && (
              <p className="text-center text-[10px] text-[#8a8f98] leading-snug">
                Deploy a trading agent first to enable funding.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── Withdraw Confirmation Modal ── */}
      {showWithdrawConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-[#1A1D20] border border-[#4E8981]/40 rounded-2xl p-8 max-w-sm w-full mx-4 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-amber-950/30 border border-amber-900/30 flex items-center justify-center flex-shrink-0">
                <Warning size={20} className="text-amber-400" />
              </div>
              <div>
                <h3 className="text-white font-bold text-sm">Confirm Withdrawal</h3>
                <p className="text-[#8a8f98] text-xs">This action cannot be undone</p>
              </div>
            </div>
            <div className="bg-[#0B0B0C] rounded-xl p-4 mb-6 space-y-2 border border-[#2A2F35]">
              <div className="flex justify-between text-xs">
                <span className="text-[#8a8f98]">Amount</span>
                <span className="text-white font-mono font-bold">{parseFloat(twAmount).toFixed(6)} USDC</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-[#8a8f98]">From</span>
                <span className="text-[#5fa399] font-mono">{shortTwAddress ?? 'Trading Wallet'}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-[#8a8f98]">To</span>
                <span className="text-white font-mono text-[11px]">
                  {twWithdrawDestMode === 'fee'
                    ? (feeWalletAddress ? `${feeWalletAddress.slice(0, 8)}...${feeWalletAddress.slice(-6)} (Fee Wallet)` : 'Fee Wallet')
                    : `${twCustomDestAddress.slice(0, 8)}...${twCustomDestAddress.slice(-6)} (Custom)`}
                </span>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                id="billing-tw-withdraw-cancel"
                onClick={() => setShowWithdrawConfirm(false)}
                className="flex-1 py-3 bg-transparent border border-[#2A2F35] text-[#8a8f98] hover:border-[#4E8981]/50 hover:text-white rounded-xl text-xs font-bold transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                id="billing-tw-withdraw-confirm"
                onClick={() => {
                  if (fundTarget === 'fee') {
                    void handleWithdrawFeeWallet();
                  } else {
                    void handleWithdrawTradingWallet();
                  }
                }}
                className="flex-1 py-3 bg-transparent border border-[#3b82f6] text-[#60a5fa] hover:text-white hover:border-[#60a5fa] rounded-xl text-xs font-bold transition-all cursor-pointer"
              >
                Confirm Withdrawal
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Transaction Ledger */}
      <div className="bg-[#1A1D20] rounded-xl overflow-hidden border border-[#2A2F35]">
        <div className="px-6 py-5 border-b border-[#2A2F35] flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-[#1A1D20]">
          <h4 className="text-xs font-bold text-white uppercase tracking-widest">Transaction Ledger</h4>
          <div className="relative w-full sm:w-64">
            <MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8a8f98]" size={16} />
            <input
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              className="pl-9 pr-4 py-2 border border-[#2A2F35] bg-[#0B0B0C] text-white rounded-xl text-xs w-full focus:outline-none focus:border-[#4E8981]"
              placeholder="Filter transactions..."
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-[#0B0B0C]/40 border-b border-[#2A2F35]">
                <th className="px-6 py-4 text-[10px] font-bold text-[#8a8f98] uppercase tracking-wider">Agent / Action</th>
                <th className="px-6 py-4 text-[10px] font-bold text-[#8a8f98] uppercase tracking-wider">Tx Type</th>
                <th className="px-6 py-4 text-[10px] font-bold text-[#8a8f98] uppercase tracking-wider">Timestamp</th>
                <th className="px-6 py-4 text-[10px] font-bold text-[#8a8f98] uppercase tracking-wider">Status</th>
                <th className="px-6 py-4 text-[10px] font-bold text-[#8a8f98] uppercase tracking-wider text-right">Amount (USDC)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2A2F35]">
              {/* Skeleton */}
              {isLoadingLogs && [...Array(4)].map((_, i) => (
                <tr key={i} className="border-b border-[#2A2F35]">
                  <td className="px-6 py-4"><div className="flex items-center gap-3"><div className="w-8 h-8 rounded-lg skeleton-pulse flex-shrink-0" /><div className="h-3 w-32 skeleton-pulse rounded" /></div></td>
                  <td className="px-6 py-4"><div className="h-3 w-20 skeleton-pulse rounded" /></td>
                  <td className="px-6 py-4"><div className="h-3 w-28 skeleton-pulse rounded" /></td>
                  <td className="px-6 py-4"><div className="h-5 w-20 skeleton-pulse rounded-full" /></td>
                  <td className="px-6 py-4 text-right"><div className="h-3 w-20 skeleton-pulse rounded ml-auto" /></td>
                </tr>
              ))}

              {/* Empty */}
              {!isLoadingLogs && filteredLogs.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="flex flex-col items-center justify-center py-16 gap-3 text-[#8a8f98]">
                      <EmptyIcon size={32} className="opacity-30" />
                      <p className="text-xs font-semibold uppercase tracking-wider opacity-50">
                        {filterQuery ? 'No transactions match your filter' : 'No transactions yet'}
                      </p>
                      {filterQuery && (
                        <button onClick={() => setFilterQuery('')} className="text-[10px] text-[#4E8981] hover:underline cursor-pointer">
                          Clear filter
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )}

              {/* Rows */}
              {!isLoadingLogs && filteredLogs.map((log) => (
                <tr key={log.id} className="hover:bg-[#0B0B0C]/20 transition-colors cursor-pointer">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                        log.status === 'FAILURE'
                          ? 'bg-rose-950/30 border border-rose-900/30 text-rose-400'
                          : 'bg-[#4E8981]/10 border border-[#4E8981]/20 text-[#4E8981]'
                      }`}>
                        {log.status === 'FAILURE' ? <Database size={16} /> : <Cpu size={16} />}
                      </div>
                      <span className="text-xs text-white font-semibold">{log.agent_name}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border ${
                      log.tx_type === 'Deployment' ? 'bg-sky-950/30 border-sky-900/30 text-sky-400'
                      : log.tx_type === 'Nanopayment' ? 'bg-violet-950/30 border-violet-900/30 text-violet-400'
                      : log.tx_type === 'Listing' ? 'bg-amber-950/30 border-amber-900/30 text-amber-400'
                      : log.tx_type === 'Transfer In' ? 'bg-emerald-950/30 border-emerald-900/30 text-emerald-400'
                      : 'bg-[#2A2F35]/50 border-[#2A2F35] text-[#8a8f98]'
                    }`}>
                      {log.tx_type ?? '—'}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-xs text-[#8a8f98]">{(() => { try { return new Date(log.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return log.timestamp; } })()}</td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${
                      log.status === 'SUCCESS'
                        ? 'bg-emerald-950/30 border border-emerald-900/30 text-emerald-400'
                        : 'bg-rose-950/30 border border-rose-900/30 text-rose-400'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${log.status === 'SUCCESS' ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                      {log.status}
                    </span>
                  </td>
                  <td className={`px-6 py-4 text-right text-xs font-bold ${log.cost_usdc < 0 ? 'text-emerald-400' : 'text-white'}`}>
                    {log.cost_usdc < 0 ? '+' : log.cost_usdc === 0 ? '' : '-'}{Math.abs(log.cost_usdc).toFixed(4)} USDC
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
