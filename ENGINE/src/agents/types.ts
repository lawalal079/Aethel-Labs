export interface AgentRateConfig {
  // ── Legacy wall-clock fields (kept for backward compatibility; no longer used for billing) ──
  rateAtomicPerMs: bigint;
  minFeeAtomic: bigint;

  // ── Resource-based billing fields ─────────────────────────────────────────────
  /** USDC per 1 000 input tokens (6-decimal atomic units, e.g. 200n = $0.000200) */
  inputTokenRateAtomic: bigint;
  /** USDC per 1 000 output tokens (6-decimal atomic units) */
  outputTokenRateAtomic: bigint;
  /** Fixed fee per completed tool action / audit cycle (e.g. 2000n = $0.002000) */
  milestoneRateAtomic: bigint;
  /**
   * When true, this agent performs heavy automated work (multi-step file deployments,
   * live on-chain actions, daemon loops) that warrants a full escrow lock + settle cycle.
   * When false (e.g. simple chat / single LLM query), on-chain settlement is skipped.
   */
  heavyTask: boolean;
}

export interface AgentModuleOutput {
  dataSource: string;
  targetIdentity: string;
  verifiedSourceUrl: string;   // Absolute URL the agent compiles pointing to its live data source
  liveMetrics: Record<string, any>;
  analysis: string;
}

export interface AgentHandlerContext {
  verifiedUserAddress?: string;
  userId?: string;
}

export interface AgentConfiguration {
  id: string;
  displayName: string;
  loadingStates: string[];
  lineageSchema: string[];
  rateConfig: AgentRateConfig;
  handler: (intent: string, context?: AgentHandlerContext) => Promise<AgentModuleOutput>;
}

