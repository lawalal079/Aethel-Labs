import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

export const GEMINI_MODEL = 'gemini-2.5-flash';

export interface AgentSessionMessage {
  role: 'user' | 'agent';
  content: string;
  timestamp: number;
  userId: string;
}

export interface PersistentChatThread {
  userId: string;       // Binds strictly to privyUser?.id or validated OAuth ID (Circle user address)
  agentId: string;      // Separates history across the different agents
  messages: {
    role: 'user' | 'agent';
    content: string;
    timestamp: number;
  }[];
}

// ── Filesystem-backed database emulation ─────────────────────────────────────
const SESSIONS_DIR = path.resolve(__dirname, '../../data/sessions');

function ensureSessionsDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function getSessionFilePath(userId: string, agentId: string): string {
  // Sanitize keys to safe filename characters. Prefixing with chats_{agentId} ensures
  // physically distinct file partitions on disk per agent.
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return path.join(SESSIONS_DIR, `chats_${safe(agentId)}_${safe(userId)}.json`);
}

// Emulates MongoDB collection operations using filesystem storage
const db = {
  get chats(): PersistentChatThread[] {
    ensureSessionsDir();
    const threads: PersistentChatThread[] = [];
    try {
      const files = fs.readdirSync(SESSIONS_DIR);
      for (const file of files) {
        if (file.endsWith('.json') && file.startsWith('chats_')) {
          try {
            const raw = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8');
            const parsed = JSON.parse(raw);
            
            // File naming structure: chats_{agentId}_{userId}.json
            const base = file.slice(6, -5); // strip "chats_" and ".json"
            
            if (Array.isArray(parsed)) {
              // Legacy array format fallback: extract agentId and userId from filename
              const agentIds = [
                'trading_bot_core',
                'agent_yield_harvester',
                'agent_python_coding',
                'agent_solidity_dev',
                'agent_arbitrage_bot',
                'agent_sentiment_ai',
                'agent_mev_protection',
                'agent_portfolio_mgmt'
              ];
              let inferredAgentId = 'unknown';
              for (const aid of agentIds) {
                if (base.startsWith(aid)) {
                  inferredAgentId = aid;
                  break;
                }
              }
              const inferredUserId = base.startsWith(inferredAgentId)
                ? base.slice(inferredAgentId.length + 1)
                : base;

              threads.push({
                userId: inferredUserId,
                agentId: inferredAgentId,
                messages: parsed
              });
            } else {
              // Modern partitioned schema format
              threads.push({
                userId: parsed.userId || '',
                agentId: parsed.agentId || '',
                messages: parsed.messages || []
              });
            }
          } catch {}
        }
      }
    } catch (e) {
      console.warn(`[db] Failed to read sessions directory:`, e);
    }
    return threads;
  },
  save: (thread: PersistentChatThread): void => {
    try {
      const filePath = getSessionFilePath(thread.userId, thread.agentId);
      ensureSessionsDir();
      fs.writeFileSync(filePath, JSON.stringify(thread, null, 2), 'utf-8');
    } catch (e) {
      console.error(`[db] Failed to write session for user ${thread.userId}:`, e);
    }
  }
};

// Tracks active userId per walletAddress to detect mid-session switches
const activeSessions: Record<string, string> = {};

/**
 * Resolves the verified user identity (either Privy DID or Circle user address)
 * and retrieves the persistent chat thread from the database layer.
 */
export function getChatHistory(
  userId: string | undefined,
  walletAddress: string | undefined,
  agentId: string
): AgentSessionMessage[] {
  if (!userId) return [];

  // Identity shift check — update in-memory state tracking only
  if (walletAddress) {
    const activeUserForWallet = activeSessions[walletAddress];
    if (activeUserForWallet && activeUserForWallet !== userId) {
      console.warn(`🔒 Identity boundary shift: ${activeUserForWallet} → ${userId}. Updating active session variable.`);
    }
    activeSessions[walletAddress] = userId;
  }

  // HARD AGENT DATA SEPARATION: Bound storage query strictly to this compound key
  const storageKey = `${userId}_${agentId}`;

  // Read strictly from the database matching the storageKey's partitioned structure
  const explicitThread = db.chats.find(
    (item) => {
      const itemKey = `${item.userId}_${item.agentId}`;
      return itemKey === storageKey && item.agentId === agentId;
    }
  );
  return explicitThread
    ? explicitThread.messages.map(msg => ({
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        userId: explicitThread.userId
      }))
    : [];
}

/**
 * Appends a new message to the persistent chat thread for the verified user.
 */
export function saveChatMessage(
  userId: string | undefined,
  walletAddress: string | undefined,
  agentId: string,
  role: 'user' | 'agent',
  content: string
): void {
  if (!userId) return;

  // Identity shift check — update in-memory state tracking only
  if (walletAddress) {
    const activeUserForWallet = activeSessions[walletAddress];
    if (activeUserForWallet && activeUserForWallet !== userId) {
      console.warn(`🔒 Identity boundary shift on write: ${activeUserForWallet} → ${userId}. Updating active session variable.`);
    }
    activeSessions[walletAddress] = userId;
  }

  // HARD AGENT DATA SEPARATION: Bound storage query strictly to this compound key
  const storageKey = `${userId}_${agentId}`;

  // Read strictly from the database matching the storageKey's partitioned structure
  const explicitThread = db.chats.find(
    (item) => {
      const itemKey = `${item.userId}_${item.agentId}`;
      return itemKey === storageKey && item.agentId === agentId;
    }
  ) || {
    userId,
    agentId,
    messages: []
  };

  explicitThread.messages.push({
    role,
    content,
    timestamp: Date.now()
  });

  db.save(explicitThread);
}






/**
 * Extracts clean narrative text from a compiled markdown result block.
 * This keeps the LLM's conversational context free of data lineage details and logs.
 */
export function extractNarrative(content: string): string {
  if (content.includes('### 🔎 Data Lineage & Verification')) {
    const parts = content.split('---');
    if (parts.length >= 3) {
      const narrativePart = parts[2].split('<details>')[0];
      return narrativePart.trim();
    }
  }
  return content;
}



/** HTTP status codes that are transient and safe to rotate/retry */
const GEMINI_RATE_LIMIT_CODE = 429;           // rotate key immediately, no delay
const GEMINI_OVERLOAD_CODES  = new Set([503, 529]); // rotate key + brief backoff

// ── API Key Pool ──────────────────────────────────────────────────────────────
// Reads all configured Gemini keys dynamically at runtime.
function getGeminiKeysPool(): string[] {
  const keys: string[] = [];
  Object.keys(process.env).forEach(envKey => {
    if (/^GEMINI_API_KEY/i.test(envKey) || /^NEXT_PUBLIC_GEMINI_API_KEY/i.test(envKey) || /^GEMINI_KEY/i.test(envKey)) {
      const val = process.env[envKey];
      if (val) {
        val.split(',').forEach(k => {
          const trimmed = k.trim();
          if (trimmed && !keys.includes(trimmed)) {
            keys.push(trimmed);
          }
        });
      }
    }
  });
  return keys;
}

// Shared round-robin cursor — persists across calls so keys are reused evenly
let geminiKeyIndex = 0;

function getNextGeminiKey(): string {
  const pool = getGeminiKeysPool();
  if (pool.length === 0) {
    throw new Error('No Gemini API keys configured. Set GEMINI_API_KEY (and optionally GEMINI_API_KEY2…6) in ENGINE/.env');
  }
  const key = pool[geminiKeyIndex % pool.length];
  geminiKeyIndex = (geminiKeyIndex + 1) % pool.length;
  return key;
}

/**
 * Calls the Gemini API with automatic key rotation on rate-limit (429) and overload (503/529).
 *
 * Rotation strategy:
 *  - 429 Rate Limited  → rotate to next key immediately (no wait)
 *  - 503/529 Overload  → rotate to next key + brief exponential backoff
 *  - 4xx permanent     → throw immediately, no retry
 *
 * Total attempts = GEMINI_KEYS.length × 2 full rotations before giving up.
 */
export async function callGemini(systemPrompt: string, dataPayload: object): Promise<string> {
  const pool = getGeminiKeysPool();
  if (pool.length === 0) {
    throw new Error('No Gemini API keys configured. Set GEMINI_API_KEY in ENGINE/.env');
  }

  const fullPrompt = `${systemPrompt}

LIVE DATA PAYLOAD (use these exact values in your output — do not fabricate any numbers):
${JSON.stringify(dataPayload, null, 2)}`;

  // Allow up to 2 full rotations through all available keys
  const maxAttempts = pool.length * 2;
  let lastError: Error | null = null;
  let backoffMs = 1500;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const apiKey = getNextGeminiKey();
    const keyLabel = `key[${((geminiKeyIndex - 1 + pool.length) % pool.length) + 1}/${pool.length}]`;

    let response: Response;
    // 90-second per-attempt abort signal — prevents request from hanging indefinitely
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90_000);
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: fullPrompt }] }],
            // Raise token ceiling so Python/Solidity/arbitrage outputs never truncate mid-generation
            generationConfig: {
              maxOutputTokens: 4096,
              temperature: 0.7,
            }
          })
        }
      );
    } catch (networkErr: any) {
      clearTimeout(timeoutId);
      // Network-level failure or AbortError — backoff and retry on next key
      lastError = new Error(`Network error on attempt ${attempt}: ${networkErr.message}`);
      console.warn(`[callGemini] ${keyLabel} Network error on attempt ${attempt}/${maxAttempts}. Rotating key + retrying…`);
      await new Promise(res => setTimeout(res, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 16000);
      continue;
    }
    clearTimeout(timeoutId);


    if (response.ok) {
      const json: any = await response.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!text) {
        throw new Error('Gemini returned an empty response. Cannot produce analysis.');
      }
      if (attempt > 1) {
        console.log(`[callGemini] ✓ Success on attempt ${attempt}/${maxAttempts} using ${keyLabel}`);
      }
      return text;
    }

    const errBody = await response.text().catch(() => '(no body)');
    const isQuota = errBody.includes('RESOURCE_EXHAUSTED') || errBody.includes('quota');
    const errSummary = isQuota ? 'Quota exceeded (429)' : `HTTP ${response.status}`;
    lastError = new Error(`Gemini API ${errSummary}`);

    if (response.status === GEMINI_RATE_LIMIT_CODE) {
      // 429: rate limited on this key — rotate immediately, no sleep
      console.warn(`[callGemini] ⚡ 429 Rate Limited on ${keyLabel} (attempt ${attempt}/${maxAttempts}). Rotating key immediately…`);
      continue;
    }

    if (GEMINI_OVERLOAD_CODES.has(response.status)) {
      // 503/529: service overloaded — rotate key AND apply backoff
      console.warn(`[callGemini] ⏳ ${response.status} Overload on ${keyLabel} (attempt ${attempt}/${maxAttempts}). Rotating key + waiting ${backoffMs}ms…`);
      await new Promise(res => setTimeout(res, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 16000);
      continue;
    }

    // Permanent error (400, 401, 403, etc.) — throw immediately
    throw new Error(`Gemini API permanent error HTTP ${response.status} on ${keyLabel}: ${errBody}`);
  }

  throw lastError ?? new Error(`Gemini API failed after ${maxAttempts} attempts across ${GEMINI_KEYS.length} keys.`);
}



/**
 * Extracts the primary token pair or ticker symbol and the network from a free-form intent string.
 * Returns null if no recognisable pair or ticker is found.
 * Examples: "PEPE/WETH on monad 500 candles" -> { query: "PEPE/WETH", baseToken: "PEPE", quoteToken: "WETH", network: "monad", candleLimit: 500 }
 */
export function extractTickerFromIntent(intent: string): {
  query: string;
  baseToken: string;
  quoteToken: string | null;
  network: string;
  candleLimit: number;
  timeframe: 'minute' | 'hour' | 'day';
  aggregate: number;
} | null {
  let network = "eth";
  const lowerIntent = intent.toLowerCase();

  if (lowerIntent.includes("monad")) {
    network = "monad";
  } else if (lowerIntent.includes("base")) {
    network = "base";
  } else if (lowerIntent.includes("solana")) {
    network = "solana";
  } else if (lowerIntent.includes("arbitrum")) {
    network = "arbitrum";
  } else if (lowerIntent.includes("arc")) {
    network = "arc";
  } else if (lowerIntent.includes("eth")) {
    network = "eth";
  }

  // Parse explicit candle limit from the prompt (e.g. "500 candles", "200 bars", "300 periods")
  const DEFAULT_CANDLE_LIMIT = 500;
  const MAX_CANDLE_LIMIT     = 1000;
  let candleLimit = DEFAULT_CANDLE_LIMIT;
  const limitMatch = intent.match(/\b(\d+)\s*(?:candles?|bars?|periods?)\b/i);
  if (limitMatch) {
    candleLimit = Math.min(parseInt(limitMatch[1], 10), MAX_CANDLE_LIMIT);
  }

  // Parse explicit timeframe and aggregate
  let timeframe: 'minute' | 'hour' | 'day' = 'hour';
  let aggregate = 1;

  const tfMatch = intent.match(/\b(\d+)\s*(mins?|minutes?|hrs?|hours?|days?|daily|m|h|d)\b/i);
  if (tfMatch) {
    const rawVal = parseInt(tfMatch[1], 10);
    const rawUnit = tfMatch[2].toLowerCase();

    let mappedUnit: 'minute' | 'hour' | 'day' = 'hour';
    if (['min', 'mins', 'minute', 'minutes', 'm'].includes(rawUnit)) {
      mappedUnit = 'minute';
    } else if (['hr', 'hrs', 'hour', 'hours', 'h'].includes(rawUnit)) {
      mappedUnit = 'hour';
    } else if (['day', 'days', 'daily', 'd'].includes(rawUnit)) {
      mappedUnit = 'day';
    }

    let resolvedAggregate = rawVal;
    if (mappedUnit === 'minute') {
      const allowed = [1, 5, 15, 30];
      if (!allowed.includes(rawVal)) {
        resolvedAggregate = allowed.reduce((prev, curr) => 
          Math.abs(curr - rawVal) < Math.abs(prev - rawVal) ? curr : prev
        );
      }
    } else if (mappedUnit === 'hour') {
      const allowed = [1, 4, 12];
      if (!allowed.includes(rawVal)) {
        resolvedAggregate = allowed.reduce((prev, curr) => 
          Math.abs(curr - rawVal) < Math.abs(prev - rawVal) ? curr : prev
        );
      }
    } else if (mappedUnit === 'day') {
      resolvedAggregate = 1;
    }

    timeframe = mappedUnit;
    aggregate = resolvedAggregate;
  } else {
    // Shorthand tags fallback
    const lower = intent.toLowerCase();
    if (lower.includes('daily') || lower.includes('day')) {
      timeframe = 'day';
      aggregate = 1;
    } else if (lower.includes('4h')) {
      timeframe = 'hour';
      aggregate = 4;
    } else if (lower.includes('15m')) {
      timeframe = 'minute';
      aggregate = 15;
    } else if (lower.includes('5m')) {
      timeframe = 'minute';
      aggregate = 5;
    } else {
      timeframe = 'hour';
      aggregate = 1;
    }
  }

  let query: string | null = null;
  let baseToken: string | null = null;
  let quoteToken: string | null = null;

  const pairMatch = intent.match(/\b([A-Z0-9]{2,12})[\/\-]([A-Z0-9]{2,12})\b/i);
  if (pairMatch) {
    baseToken  = pairMatch[1].toUpperCase();
    quoteToken = pairMatch[2].toUpperCase();
    query      = `${baseToken}/${quoteToken}`;
  } else {
    const singleMatch = intent.match(/\b(?:analyze|check|scan|monitor|watch|inspect|trade|swap)\s+([A-Z0-9]{2,12})\b/i);
    if (singleMatch) {
      baseToken = singleMatch[1].toUpperCase();
      query     = baseToken;
    } else {
      const capsMatch = intent.match(/\b([A-Z0-9]{2,12})\b/i);
      if (capsMatch) {
        baseToken = capsMatch[1].toUpperCase();
        query     = baseToken;
      }
    }
  }

  if (!query || !baseToken) {
    return null;
  }

  return { query, baseToken, quoteToken, network, candleLimit, timeframe, aggregate };
}

