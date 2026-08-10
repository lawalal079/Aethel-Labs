'use client';

import React, { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react';
import { createPublicClient, formatUnits, getAddress, http, parseAbi, type Address, type Chain } from 'viem';
import { setCookie, getCookie } from 'cookies-next';
import { SocialLoginProvider } from '@circle-fin/w3s-pw-web-sdk/dist/src/types';
import type { W3SSdk } from '@circle-fin/w3s-pw-web-sdk';

// ─── Environment config ────────────────────────────────────────────────────────

const CHAIN_ID = parseInt(process.env.NEXT_PUBLIC_CHAIN_ID ?? '5042002', 10);
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://rpc.testnet.arc.network';
const APP_ID = process.env.NEXT_PUBLIC_CIRCLE_APP_ID as string;
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID as string;

// ─── Viem & USDC config ───────────────────────────────────────────────────────

const USDC_ADDRESS = (process.env.NEXT_PUBLIC_USDC_ADDRESS ?? '') as Address;
const GATEWAY_WALLET_ADDRESS = (process.env.NEXT_PUBLIC_GATEWAY_WALLET_ADDRESS ?? '0x0077777d7EBA4688BDeF3E311b846F25870A19B9') as Address;

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

const GATEWAY_ABI = parseAbi([
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
  transport: http(RPC_URL, {
    timeout: 8_000,
    retryCount: 2,
    retryDelay: 500,
  }),
});

/** Retry helper — fast exponential backoff for RPC calls. */
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 2, baseDelayMs = 400): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 200;
        await new Promise(res => setTimeout(res, delay));
      }
    }
  }
  throw lastErr;
}

/** Wallet balance — Agent Wallet's own USDC via balanceOf() */
async function fetchUsdcBalance(address: Address): Promise<string> {
  if (!USDC_ADDRESS) return '0.00';
  try {
    const checksummed = getAddress(address);
    const raw = await withRetry(() =>
      publicClient.readContract({ address: getAddress(USDC_ADDRESS), abi: ERC20_ABI, functionName: 'balanceOf', args: [checksummed] })
    );
    return parseFloat(formatUnits(raw as bigint, 6)).toFixed(2);
  } catch (err) {
    console.warn('[CircleWalletProvider] fetchUsdcBalance error (all retries exhausted):', err);
    return '0.00';
  }
}

/** Spending balance — Gateway's available balance via on-chain contract + API fallback */
async function fetchGatewayBalance(address: Address): Promise<string> {
  if (!address) return '0.00';
  try {
    const checksummed = getAddress(address);
    
    // 1. Primary: On-chain GatewayWallet.availableBalance (reflects immediate on-chain state)
    try {
      const raw = await withRetry(() =>
        publicClient.readContract({
          address: getAddress(GATEWAY_WALLET_ADDRESS),
          abi: GATEWAY_ABI,
          functionName: 'availableBalance',
          args: [getAddress(USDC_ADDRESS), checksummed],
        })
      );
      const val = parseFloat(formatUnits(raw as bigint, 6)).toFixed(6);
      if (val !== undefined && val !== null && !isNaN(parseFloat(val))) {
        return val;
      }
    } catch (onChainErr) {
      console.warn('[CircleWalletProvider] On-chain Gateway read failed, trying API fallback:', onChainErr);
    }

    // 2. Fallback: Query Circle Gateway /v1/balances REST API endpoint
    try {
      const circleRes = await fetch('https://gateway-api-testnet.circle.com/v1/balances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'USDC',
          sources: [{ depositor: checksummed, domain: 26 }],
        }),
      });
      if (circleRes.ok) {
        const circleData = await circleRes.json();
        const found = circleData?.balances?.[0]?.balance;
        if (found !== undefined && found !== null) {
          return parseFloat(found).toFixed(6);
        }
      }
    } catch (apiErr) {}

    return '0.00';
  } catch (err) {
    console.warn('[CircleWalletProvider] fetchGatewayBalance error:', err);
    return '0.00';
  }
}

// ─── Context ──────────────────────────────────────────────────────────────────

export interface CircleWalletContextValue {
  isConnected: boolean;
  isConnecting: boolean;
  walletAddress: string | null;
  usdcBalance: string;        // Backward-compat alias for walletBalance
  walletBalance: string;      // "Wallet balance" — Agent Wallet's own USDC via balanceOf()
  spendingBalance: string;    // "Spending balance" — Gateway's available balance via availableBalance()
  setSpendingBalance: React.Dispatch<React.SetStateAction<string>>;
  tradingWalletAddress: string | null; // "Trading Wallet" — Developer-Controlled Wallet for automated swaps
  tradingWalletBalance: string; // Trading Wallet USDC balance
  tradingWalletHoldings: { symbol: string; name: string; balance: string; address: string }[];
  isTradingWalletProvisioned: boolean;
  feeWalletAddress: string | null; // "Fee Wallet" — Developer-Controlled Wallet for $0.0001 USDC task fee
  feeWalletBalance: string; // Fee Wallet USDC balance
  isFeeWalletProvisioned: boolean;
  authMethod: 'circle_google' | null;
  authStatusMessage: string | null;
  loginWithGoogle: () => Promise<void>;
  logout: () => void;
  authError: string | null;
  refreshBalance: () => Promise<void>;
  refreshTradingWallet: () => Promise<void>;
  loginResult?: LoginResult | null;
  circleWallets?: Wallet[];
  executeChallenge?: (challengeId: string) => Promise<unknown>;
  signTypedData?: (domain: any, types: any, value: any) => Promise<string>;
}

const DEFAULT_VALUE: CircleWalletContextValue = {
  isConnected: false,
  isConnecting: false,
  walletAddress: null,
  usdcBalance: '0.00',
  walletBalance: '0.00',
  spendingBalance: '0.00',
  setSpendingBalance: () => {},
  tradingWalletAddress: null,
  tradingWalletBalance: '0.00',
  tradingWalletHoldings: [],
  isTradingWalletProvisioned: false,
  feeWalletAddress: null,
  feeWalletBalance: '0.00',
  isFeeWalletProvisioned: false,
  authMethod: null,
  authStatusMessage: null,
  loginWithGoogle: async () => {},
  logout: () => {},
  authError: null,
  refreshBalance: async () => {},
  refreshTradingWallet: async () => {},
  loginResult: null,
  circleWallets: [],
  executeChallenge: async () => { throw new Error("executeChallenge not implemented"); },
};

export const CircleWalletContext = createContext<CircleWalletContextValue>(DEFAULT_VALUE);

// ─── Types ────────────────────────────────────────────────────────────────────

type LoginResult = {
  userToken: string;
  encryptionKey: string;
};

type Wallet = {
  id: string;
  address: string;
  blockchain: string;
  [key: string]: unknown;
};

// ─── Provider ─────────────────────────────────────────────────────────────────

export function CircleWalletProvider({ children }: { children: React.ReactNode }) {
  // ── Circle State ───────────────────────────────────────────────────────────
  const sdkRef = useRef<W3SSdk | null>(null);
  const [sdkReady, setSdkReady] = useState(false);
  const [deviceId, setDeviceId] = useState<string>('');
  const [deviceIdLoading, setDeviceIdLoading] = useState(false);
  const [deviceToken, setDeviceToken] = useState<string>('');
  const [deviceEncryptionKey, setDeviceEncryptionKey] = useState<string>('');
  const [loginResult, setLoginResult] = useState<LoginResult | null>(() => {
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem('circle_login_result');
      if (stored) {
        try {
          return JSON.parse(stored);
        } catch {}
      }
    }
    return null;
  });
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [circleWallets, setCircleWallets] = useState<Wallet[]>([]);

  // ── Shared State ───────────────────────────────────────────────────────────
  const [usdcBalance, setUsdcBalance] = useState('0.00'); // Wallet balance (balanceOf)
  const [spendingBalance, setSpendingBalance] = useState('0.00'); // Spending balance (Gateway availableBalance)
  const [tradingWalletAddress, setTradingWalletAddress] = useState<string | null>(null);
  const [tradingWalletBalance, setTradingWalletBalance] = useState('0.00');
  const [tradingWalletHoldings, setTradingWalletHoldings] = useState<{ symbol: string; name: string; balance: string; address: string }[]>([]);
  const [isTradingWalletProvisioned, setIsTradingWalletProvisioned] = useState(false);
  const [feeWalletAddress, setFeeWalletAddress] = useState<string | null>(null);
  const [feeWalletBalance, setFeeWalletBalance] = useState('0.00');
  const [isFeeWalletProvisioned, setIsFeeWalletProvisioned] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authStatusMessage, setAuthStatusMessage] = useState<string | null>(null);
  const [authInProgress, setAuthInProgress] = useState(false);
  const balancePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tradingWalletPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Determine active Circle connection
  const cachedUserAddress = typeof window !== 'undefined' ? window.localStorage.getItem('circle_user_address') : null;
  const activeCircleWallet = circleWallets[0]?.address ?? cachedUserAddress ?? null;
  const isConnected = !!activeCircleWallet;
  const walletAddress = activeCircleWallet;
  const authMethod = isConnected ? 'circle_google' : null;

  // ── Circle SDK Initialization ──────────────────────────────────────────────
  useEffect(() => {
    if (!APP_ID) return;

    let cancelled = false;

    const initSdk = async () => {
      try {
        const { W3SSdk } = await import('@circle-fin/w3s-pw-web-sdk');

        const onLoginComplete = (error: unknown, result: any) => {
          if (cancelled) return;
          if (error) {
            const msg = (error as any)?.message || String(error);
            if (msg.includes('AbortError') || msg.includes('signal is aborted') || msg.includes('app config')) return;
            console.error('Circle login failed:', error);
            setAuthError(msg || 'Circle login failed');
            setLoginResult(null);
            setAuthStatusMessage('Login failed');
            return;
          }
          const newResult = {
            userToken: result.userToken,
            encryptionKey: result.encryptionKey,
          };
          if (typeof window !== 'undefined') window.localStorage.setItem('circle_login_result', JSON.stringify(newResult));
          setLoginResult(newResult);
          setAuthError(null);
          setAuthStatusMessage('Login successful. Initializing Agent Wallet...');
        };

        const restoredAppId = (getCookie('appId') as string) || APP_ID || '';
        const restoredGoogleClientId = (getCookie('google.clientId') as string) || GOOGLE_CLIENT_ID || '';
        const restoredDeviceToken = (getCookie('deviceToken') as string) || '';
        const restoredDeviceEncryptionKey = (getCookie('deviceEncryptionKey') as string) || '';

        const initialConfig = {
          appSettings: { appId: restoredAppId },
          loginConfigs: {
            deviceToken: restoredDeviceToken,
            deviceEncryptionKey: restoredDeviceEncryptionKey,
            google: {
              clientId: restoredGoogleClientId,
              redirectUri: typeof window !== 'undefined' ? window.location.origin : '',
              selectAccountPrompt: true,
            },
          },
        };

        const sdk = new W3SSdk(initialConfig, onLoginComplete);
        sdkRef.current = sdk;

        if (!cancelled) setSdkReady(true);
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (!msg.includes('AbortError') && !msg.includes('signal is aborted') && !msg.includes('app config')) {
          console.error('Failed to init Circle Web SDK:', err);
        }
      }
    };

    void initSdk();
    return () => { cancelled = true; };
  }, []);

  // ── Get / Cache Device ID ──────────────────────────────────────────────────
  useEffect(() => {
    const fetchDeviceId = async () => {
      if (!sdkRef.current) return;
      try {
        const cached = typeof window !== 'undefined' ? window.localStorage.getItem('deviceId') : null;
        if (cached) {
          setDeviceId(cached);
          return;
        }
        setDeviceIdLoading(true);
        const id = await sdkRef.current.getDeviceId();
        setDeviceId(id);
        if (typeof window !== 'undefined') window.localStorage.setItem('deviceId', id);
      } catch (error) {
        console.error('Failed to get deviceId:', error);
      } finally {
        setDeviceIdLoading(false);
      }
    };
    if (sdkReady) void fetchDeviceId();
  }, [sdkReady]);

  // ── Step 1: Create Device Token ───────────────────────────────────────────
  const ensureDeviceToken = async (): Promise<boolean> => {
    if (deviceToken && deviceEncryptionKey) return true;
    if (!deviceId) {
      setAuthError('Missing device ID. Please try again.');
      return false;
    }
    
    setAuthStatusMessage('Creating secure device session...');
    try {
      const response = await fetch('/api/endpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'createDeviceToken', deviceId }),
      });
      const data = await response.json();
      
      if (!response.ok) {
        setAuthError(data.error || 'Failed to create device token');
        return false;
      }
      
      setDeviceToken(data.deviceToken);
      setDeviceEncryptionKey(data.deviceEncryptionKey);
      setCookie('deviceToken', data.deviceToken);
      setCookie('deviceEncryptionKey', data.deviceEncryptionKey);
      return true;
    } catch (err) {
      setAuthError('Failed to communicate with authentication server.');
      return false;
    }
  };

  // ── Step 2: Trigger Google Login ───────────────────────────────────────────
  const loginWithGoogle = async () => {
    if (!sdkRef.current) {
      setAuthError('Circle SDK not initialized yet. Please refresh the page and try again.');
      return;
    }
    
    setAuthInProgress(true);
    setAuthError(null);
    const tokenReady = await ensureDeviceToken();
    if (!tokenReady) { setAuthInProgress(false); return; }

    setCookie('appId', APP_ID);
    setCookie('google.clientId', GOOGLE_CLIENT_ID);
    
    sdkRef.current.updateConfigs({
      appSettings: { appId: APP_ID },
      loginConfigs: {
        deviceToken,
        deviceEncryptionKey,
        google: {
          clientId: GOOGLE_CLIENT_ID,
          redirectUri: window.location.origin,
          selectAccountPrompt: true,
        },
      },
    });

    setAuthStatusMessage('Redirecting to Google...');
    sdkRef.current.performLogin(SocialLoginProvider.GOOGLE);
  };

  // ── Step 3: Handle User Initialization ─────────────────────────────────────
  useEffect(() => {
    if (!loginResult?.userToken) return;

    const initializeUser = async () => {
      try {
        setAuthStatusMessage('Checking agent wallet status...');
        const response = await fetch('/api/endpoints', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'initializeUser', userToken: loginResult.userToken }),
        });
        const data = await response.json();

        if (!response.ok) {
          if (response.status === 401) {
            console.warn("Circle userToken expired or unauthorized. Logging out...");
            unifiedLogout();
            return;
          }
          if (data.code === 155106) {
            await loadCircleWallets(loginResult.userToken);
            return;
          }
          setAuthError(`[${data.code}] ${data.error || data.message}`);
          return;
        }

        setChallengeId(data.challengeId);
        setAuthStatusMessage('Waiting for Agent Wallet creation authorization...');
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (!msg.includes('AbortError') && !msg.includes('signal is aborted')) {
          setAuthError('Failed to initialize user session.');
        }
        setAuthInProgress(false);
      }
    };

    void initializeUser();
  }, [loginResult]);

  // ── Step 4: Execute Challenge (if needed) ──────────────────────────────────
  useEffect(() => {
    if (!challengeId || !sdkRef.current || !loginResult) return;

    const executeAuth = () => {
      sdkRef.current!.setAuthentication({
        userToken: loginResult.userToken,
        encryptionKey: loginResult.encryptionKey,
      });

      sdkRef.current!.execute(challengeId, (error) => {
        if (error) {
          setAuthError('Failed to authorize wallet creation: ' + (error as any).message);
          return;
        }
        
        setAuthStatusMessage('Agent Wallet created! Loading details...');
        setTimeout(() => {
          setChallengeId(null);
          void loadCircleWallets(loginResult.userToken);
        }, 2000);
      });
    };

    executeAuth();
  }, [challengeId, loginResult]);

  // ── Helper: Load Circle Wallets ────────────────────────────────────────────
  const loadCircleWallets = async (userToken: string) => {
    try {
      setAuthStatusMessage('Loading Agent Wallet details...');
      const response = await fetch('/api/endpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'listWallets', userToken }),
      });
      const data = await response.json();
      
      if (!response.ok) {
        if (response.status === 401) {
          console.warn("Circle userToken expired. Logging out...");
          unifiedLogout();
          setAuthInProgress(false);
          return;
        }
        setAuthError('Failed to load wallet details.');
        setAuthInProgress(false);
        return;
      }
      
      const fetchedWallets = (data.wallets as Wallet[]) || [];
      setCircleWallets(fetchedWallets);
      
      if (fetchedWallets.length > 0) {
        if (typeof window !== 'undefined') {
          window.localStorage.setItem('circle_user_address', fetchedWallets[0].address);
        }
        setAuthStatusMessage(null); // Success
        setAuthInProgress(false);
      } else {
        setAuthError('No Agent Wallets found for this user.');
        setAuthInProgress(false);
      }
    } catch (err) {
      setAuthError('Error fetching wallets.');
      setAuthInProgress(false);
    }
  };

  // ── Logout Handler ─────────────────────────────────────────────────────────
  const unifiedLogout = () => {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('circle_login_result');
      window.localStorage.removeItem('circle_user_address');
    }
    setLoginResult(null);
    setCircleWallets([]);
    setUsdcBalance('0.00');
    setSpendingBalance('0.00');
    setTradingWalletAddress(null);
    setTradingWalletBalance('0.00');
    setIsTradingWalletProvisioned(false);
    setAuthStatusMessage(null);
  };

  // ── Balance Polling ────────────────────────────────────────────────────────
  const refreshBalance = useCallback(async (addr: Address) => {
    // Fetch agent wallet on-chain balance
    const wBal = await fetchUsdcBalance(addr);
    if (wBal !== null && wBal !== undefined) setUsdcBalance(wBal);

    await new Promise(res => setTimeout(res, 200));

    // Gateway spending balance is queried for the Fee Wallet address
    const targetFeeAddr = (feeWalletAddress as Address) || addr;
    const sBal = await fetchGatewayBalance(targetFeeAddr);
    if (sBal !== null && sBal !== undefined) setSpendingBalance(sBal);
  }, [feeWalletAddress]);


  // ── refreshTradingWallet ───────────────────────────────────────────────────
  const refreshTradingWallet = useCallback(async (addr: string) => {
    try {
      const res = await fetch(`/api/agents/trading-wallet?userAddress=${encodeURIComponent(addr)}`);
      if (!res.ok) return;
      const data = await res.json();
      
      setIsTradingWalletProvisioned(data.provisioned ?? false);
      if (data.tradingWalletAddress) {
        setTradingWalletAddress(data.tradingWalletAddress);
      }
      if (data.balance !== undefined && data.balance !== null) {
        setTradingWalletBalance(data.balance);
      }
      if (Array.isArray(data.holdings)) {
        setTradingWalletHoldings(data.holdings);
      }

      setIsFeeWalletProvisioned(data.feeWalletProvisioned ?? false);
      if (data.feeWalletAddress) {
        setFeeWalletAddress(data.feeWalletAddress);
        // Fetch Gateway balance immediately for the user's Fee Wallet address
        const gBal = await fetchGatewayBalance(data.feeWalletAddress as Address);
        if (gBal !== null && gBal !== undefined) {
          setSpendingBalance(gBal);
        }
      }
      if (data.feeWalletBalance !== undefined && data.feeWalletBalance !== null) {
        setFeeWalletBalance(data.feeWalletBalance);
      }
    } catch (err) {
      console.warn('[CircleWalletProvider] refreshTradingWallet error:', err);
    }
  }, []);

  useEffect(() => {
    if (isConnected && walletAddress) {
      void refreshBalance(walletAddress as Address);
      if (balancePollRef.current) clearInterval(balancePollRef.current);
      // Poll balance every 10 seconds for real-time responsiveness
      balancePollRef.current = setInterval(() => void refreshBalance(walletAddress as Address), 10_000);

      // Trading wallet: initial fetch + 15s poll
      void refreshTradingWallet(walletAddress);
      if (tradingWalletPollRef.current) clearInterval(tradingWalletPollRef.current);
      tradingWalletPollRef.current = setInterval(() => void refreshTradingWallet(walletAddress), 15_000);
    } else {
      if (balancePollRef.current) {
        clearInterval(balancePollRef.current);
        balancePollRef.current = null;
      }
      if (tradingWalletPollRef.current) {
        clearInterval(tradingWalletPollRef.current);
        tradingWalletPollRef.current = null;
      }
      setUsdcBalance('0.00');
      setSpendingBalance('0.00');
      setTradingWalletAddress(null);
      setTradingWalletBalance('0.00');
      setIsTradingWalletProvisioned(false);
      setFeeWalletAddress(null);
      setFeeWalletBalance('0.00');
      setIsFeeWalletProvisioned(false);
    }
    return () => {
      if (balancePollRef.current) clearInterval(balancePollRef.current);
      if (tradingWalletPollRef.current) clearInterval(tradingWalletPollRef.current);
    };
  }, [isConnected, walletAddress, feeWalletAddress, refreshBalance, refreshTradingWallet]);

  const executeChallenge = useCallback((challengeId: string): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      if (!sdkRef.current) {
        reject(new Error("Circle SDK not initialized"));
        return;
      }
      if (!loginResult) {
        reject(new Error("User not authenticated with Circle"));
        return;
      }

      sdkRef.current.setAuthentication({
        userToken: loginResult.userToken,
        encryptionKey: loginResult.encryptionKey,
      });

      sdkRef.current.execute(challengeId, (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
    });
  }, [loginResult]);

  const signTypedData = useCallback(async (
    domain: Record<string, any>,
    types: Record<string, any>,
    value: Record<string, any>
  ): Promise<string> => {
    if (!loginResult?.userToken || !circleWallets?.[0]?.id) {
      throw new Error("Circle wallet not authenticated");
    }

    const typedData = {
      domain,
      types,
      primaryType: Object.keys(types)[0],
      message: value,
    };

    const signRes = await fetch('/api/endpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'signTypedData',
        userToken: loginResult.userToken,
        walletId: circleWallets[0].id,
        typedData,
      }),
    });

    const signJson = await signRes.json();
    if (!signRes.ok) {
      throw new Error(signJson.message ?? signJson.error ?? 'signTypedData failed');
    }

    const { challengeId } = signJson;
    if (!challengeId) throw new Error('No challengeId returned from signTypedData');

    const challengeResult = await executeChallenge(challengeId) as { data?: { signature?: string } };
    const sig = challengeResult?.data?.signature;
    if (!sig) throw new Error('Failed to obtain signature from challenge');
    return sig;
  }, [loginResult, circleWallets, executeChallenge]);

  const value: CircleWalletContextValue = {
    isConnected,
    isConnecting: authInProgress,
    walletAddress,
    usdcBalance,
    walletBalance: usdcBalance,
    spendingBalance,
    setSpendingBalance,
    tradingWalletAddress,
    tradingWalletBalance,
    tradingWalletHoldings,
    isTradingWalletProvisioned,
    feeWalletAddress,
    feeWalletBalance,
    isFeeWalletProvisioned,
    authMethod,
    authStatusMessage,
    loginWithGoogle,
    logout: unifiedLogout,
    authError,
    refreshBalance: async () => {
      if (walletAddress) {
        await refreshBalance(walletAddress as Address);
      }
    },
    refreshTradingWallet: async () => {
      if (walletAddress) {
        await refreshTradingWallet(walletAddress);
      }
    },
    loginResult,
    circleWallets,
    executeChallenge,
    signTypedData,
  };

  return (
    <CircleWalletContext.Provider value={value}>
      {children}
    </CircleWalletContext.Provider>
  );
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

export function useCircleWallet(): CircleWalletContextValue {
  return useContext(CircleWalletContext);
}

export function useWalletDisplay() {
  const { walletAddress, isConnected, usdcBalance, walletBalance, spendingBalance, authMethod, authStatusMessage } = useCircleWallet();
  const shortAddress = walletAddress
    ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
    : null;
  return { shortAddress, isConnected, usdcBalance, walletBalance, spendingBalance, authMethod, authStatusMessage };
}
