import { AgentConfiguration } from './types';
import { runSMCExecutorCycle } from './smc_executor_loop';
import { callGemini, getChatHistory, saveChatMessage, extractNarrative } from './utils';

// ── Generic Agent Config Factory (For General AI Prompt Agents) ──────────────

function createLLMAgentConfig(
  id: string,
  displayName: string,
  systemPrompt: string,
): AgentConfiguration {
  return {
    id,
    displayName,
    loadingStates: [
      `Initializing ${displayName}...`,
      'Analyzing input data...',
      'Calling Gemini Flash reasoning engine...',
      'Formatting response output...',
    ],
    lineageSchema: ['input_parse', 'gemini_reasoning', 'output_format'],
    rateConfig: {
      rateAtomicPerMs: 0n,
      minFeeAtomic: 1000n,
      inputTokenRateAtomic: 100n,
      outputTokenRateAtomic: 200n,
      milestoneRateAtomic: 1000n,
      heavyTask: false,
    },
    handler: async (intent: string, context?) => {
      const priorThread = getChatHistory(context?.userId, context?.verifiedUserAddress, id);
      saveChatMessage(context?.userId, context?.verifiedUserAddress, id, 'user', intent);

      const liveMetrics = {
        timestamp: new Date().toISOString(),
        userQuery: intent,
      };

      const rawAnalysis = await callGemini(systemPrompt + priorThread, liveMetrics);
      const narrative = extractNarrative(rawAnalysis);

      saveChatMessage(context?.userId, context?.verifiedUserAddress, id, 'agent', narrative);

      return {
        dataSource: 'Google Gemini 2.5 Flash',
        targetIdentity: context?.verifiedUserAddress ?? 'anonymous',
        verifiedSourceUrl: 'https://ai.google.dev',
        liveMetrics,
        analysis: narrative,
      };
    },
  };
}

// ── SMC Alpha Executor — one-shot handler for /dispatch compatibility ──────────

const smcAlphaExecutorConfig: AgentConfiguration = {
  id: 'agent_smc_alpha_executor',
  displayName: 'SMC Alpha Executor',
  loadingStates: [
    'Fetching EUR/USD price feed...',
    'Evaluating momentum signal...',
    'Checking spend policy...',
    'Executing swap on Arc Testnet...',
    'Writing audit log...',
  ],
  lineageSchema: ['price_feed', 'signal_decision', 'policy_gate', 'swap_execution', 'audit_log'],
  rateConfig: {
    rateAtomicPerMs: 0n,
    minFeeAtomic: 2000n,          // $0.002 minimum per cycle
    inputTokenRateAtomic: 200n,
    outputTokenRateAtomic: 400n,
    milestoneRateAtomic: 2000n,   // $0.002 per on-chain swap action
    heavyTask: true,              // live on-chain swap — full escrow lock+settle path
  },
  handler: async (_intent: string, context?) => {
    const userRefId = context?.userId ?? context?.verifiedUserAddress ?? 'user_dispatch_0x0';
    await runSMCExecutorCycle({ userRefId, once: true, intervalSeconds: 0 });
    return {
      dataSource: 'EUR/USD FX — open.er-api.com',
      targetIdentity: userRefId,
      verifiedSourceUrl: 'https://open.er-api.com/v6/latest/USD',
      liveMetrics: {},
      analysis: 'SMC Alpha Executor completed one autonomous cycle. See ENGINE/logs/execution.log for the full audit entry.',
    };
  },
};

// ── Agent Registry ─────────────────────────────────────────────────────────────

export const agentRegistry: Record<string, AgentConfiguration> = {
  // Autonomous Trading Daemon Agent
  agent_smc_alpha_executor: smcAlphaExecutorConfig,

  // Additional Marketplace Agents (Inlined for zero codebase clutter)
  trading_bot_core: createLLMAgentConfig(
    'trading_bot_core',
    'AI Trading Bot Core',
    'You are an AI Trading Bot Core. Analyze crypto market signals, technical indicators, and market momentum.',
  ),
  agent_crossdex_arb: createLLMAgentConfig(
    'agent_crossdex_arb',
    'Cross-DEX Arbitrage Bot',
    'You are a Cross-DEX Arbitrage specialist. Analyze liquidity pool prices across DEXs and spot price spread opportunities.',
  ),
  agent_arbitrage_bot: createLLMAgentConfig(
    'agent_arbitrage_bot',
    'Arbitrage Bot Engine',
    'You are an arbitrage execution engine. Detect price discrepancies across trading venues and suggest optimal swap paths.',
  ),
  agent_risk_rebalancer: createLLMAgentConfig(
    'agent_risk_rebalancer',
    'Portfolio Risk Rebalancer',
    'You are a portfolio risk management advisor. Analyze asset allocations and recommend portfolio rebalancing actions.',
  ),
  agent_portfolio_mgmt: createLLMAgentConfig(
    'agent_portfolio_mgmt',
    'Portfolio Manager',
    'You are a crypto portfolio manager. Evaluate portfolio performance, risk exposure, and asset diversification.',
  ),
  agent_python_coding: createLLMAgentConfig(
    'agent_python_coding',
    'Python Coding Assistant',
    'You are an expert Python developer. Analyze and generate clean Python code for the user request.',
  ),
  agent_solidity_dev: createLLMAgentConfig(
    'agent_solidity_dev',
    'Solidity Smart Contract Developer',
    'You are a senior Solidity engineer. Write secure, gas-optimized Smart Contracts with EVM best practices.',
  ),
  agent_yield_harvester: createLLMAgentConfig(
    'agent_yield_harvester',
    'DeFi Yield Harvester',
    'You are an autonomous DeFi yield strategy expert. Analyze liquidity pools and suggest optimal yield routes.',
  ),
  agent_sentiment_ai: createLLMAgentConfig(
    'agent_sentiment_ai',
    'Market Sentiment AI',
    'You are a market sentiment analyst. Analyze social media and news feeds for crypto market sentiment trends.',
  ),
  agent_mev_protection: createLLMAgentConfig(
    'agent_mev_protection',
    'MEV Protection Guard',
    'You are a Flashbots & MEV protection specialist. Analyze transactions for sandwich attacks and front-running risks.',
  ),
};

export interface UserAgentState {
  deployedAgentIds: string[];
  /** Per-session scoped message log — never shared across addresses */
  messages: string[];
}

export const userSessions: Record<string, UserAgentState> = {};

export * from './types';
export * from './utils';
