import { Context, Next } from 'hono';
import { recordAnalyticsEvent } from '../services/analytics.js';

export interface PaywallConfig {
  costUsdc: number; // e.g. 0.02 ($0.02)
  costSats: number; // e.g. 20 sats
  baseRecipientAddress: string;
  enableSandbox: boolean; // MUST default to false in production
  description?: string;
}

export const DEFAULT_CONFIG: PaywallConfig = {
  costUsdc: 0.02,
  costSats: 20,
  baseRecipientAddress: '0x8a8c238ed2b46908Ff6C6922a3870984f20f8913',
  enableSandbox: false, // Default: FALSE. Zero free bypass.
};

const BASE_USDC_CONTRACT = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEFAULT_BASE_RPC_URL = 'https://base.gateway.tenderly.co';
const FALLBACK_BASE_RPC_URLS = [
  'https://base.gateway.tenderly.co',
  'https://base-mainnet.public.blastapi.io',
  'https://base.meowrpc.com',
  'https://mainnet.base.org',
];
const DEFAULT_X402_FACILITATOR_URL = 'https://x402.org/facilitator';

// Maximum age for initial on-chain Base USDC transaction registration: 43,200 blocks (~24 hours at 2s/block).
// Once registered in Redis, the credit balance lives for 7 days (NONCE_TTL_SECONDS).
const MAX_TX_AGE_BLOCKS = 43200n;
const NONCE_TTL_SECONDS = 86400 * 7; // 7 days
const L402_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

// In-process caches used alongside Cloudflare KV / Upstash Redis (bounded to prevent memory DoS)
const MAX_LOCAL_NONCES = 10000;
const localSpentTokens = new Set<string>();
const localCreditBalances = new Map<string, number>();
const localFreeTrialCounts = new Map<string, number>();

// Lua scripts for 1-roundtrip atomic prepaid credit accounting in Upstash Redis
const LUA_TRY_SPEND_EXISTING = `
local bal = redis.call('GET', KEYS[1])
if not bal then return -2 end
local num = tonumber(bal)
local cost = tonumber(ARGV[1])
if num < cost then return -1 end
return redis.call('DECRBY', KEYS[1], cost)
`;

const LUA_INIT_AND_SPEND = `
local bal = redis.call('GET', KEYS[1])
local total = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
if not bal then
  local rem = total - cost
  if rem < 0 then return -1 end
  redis.call('SET', KEYS[1], rem, 'EX', ttl)
  return rem
else
  local num = tonumber(bal)
  if num < cost then return -1 end
  return redis.call('DECRBY', KEYS[1], cost)
end
`;

const LUA_REFUND_CREDITS = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.call('INCRBY', KEYS[1], tonumber(ARGV[1]))
end
return -1
`;

function getEnv(c: Context): Record<string, any> {
  const nodeEnv = typeof process !== 'undefined' && process.env ? process.env : {};
  const workerEnv = c.env && typeof c.env === 'object' ? c.env : {};
  return { ...nodeEnv, ...workerEnv };
}

function toBase64Json(obj: Record<string, any>): string {
  const jsonStr = JSON.stringify(obj);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(jsonStr, 'utf-8').toString('base64');
  }
  return btoa(jsonStr);
}

function fromBase64Json(b64: string): any {
  const decoded =
    typeof Buffer !== 'undefined'
      ? Buffer.from(b64, 'base64').toString('utf-8')
      : atob(b64);
  return JSON.parse(decoded);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function computeHmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function createSignedL402Token(
  timestamp: number,
  paymentHashHex: string,
  costSats: number,
  secret: string
): Promise<string> {
  const cleanHash = paymentHashHex.toLowerCase();
  const mac = await computeHmacSha256Hex(secret, `${timestamp}:${cleanHash}:${costSats}`);
  return `alpha402_${timestamp}_${cleanHash}_${mac}`;
}

async function upstashCommand(
  upstashUrl: string,
  upstashToken: string,
  command: (string | number)[]
): Promise<{ ok: boolean; result?: any }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(upstashUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${upstashToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
    });

    if (!res.ok) {
      console.error(`Upstash Redis error: HTTP ${res.status}`);
      return { ok: false };
    }

    const data: any = await res.json();
    if (data?.error) {
      console.error(`Upstash Redis command error: ${data.error}`);
      return { ok: false };
    }
    return { ok: true, result: data?.result };
  } catch (e) {
    console.error('Upstash Redis request error:', e);
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fast-Path Prepaid Credit Spend (0 Base RPC calls when txHash is already indexed!)
 */
async function trySpendExistingCredits(
  creditKey: string,
  costUnits: number,
  env: Record<string, any>,
  _sandboxActive: boolean
): Promise<
  | { status: 'NOT_INDEXED' }
  | { status: 'CLAIMED'; remainingUnits: number }
  | { status: 'INSUFFICIENT_CREDITS' }
  | { status: 'STORE_ERROR' }
> {
  const upstashUrl = env.UPSTASH_REDIS_REST_URL;
  const upstashToken = env.UPSTASH_REDIS_REST_TOKEN;

  if (upstashUrl && upstashToken) {
    const res = await upstashCommand(upstashUrl, upstashToken, [
      'EVAL',
      LUA_TRY_SPEND_EXISTING,
      1,
      `alpha402:credits:${creditKey}`,
      costUnits,
    ]);
    if (!res.ok || typeof res.result !== 'number') {
      return { status: 'STORE_ERROR' };
    }
    if (res.result === -2) return { status: 'NOT_INDEXED' };
    if (res.result === -1) return { status: 'INSUFFICIENT_CREDITS' };
    return { status: 'CLAIMED', remainingUnits: res.result };
  }

  const kv = env.ALPHA402_KV;
  if (kv && typeof kv.get === 'function') {
    try {
      let current: number | null = localCreditBalances.has(creditKey)
        ? localCreditBalances.get(creditKey)!
        : null;
      if (current === null) {
        const kvVal = await kv.get(`alpha402:credits:${creditKey}`);
        if (kvVal === null) return { status: 'NOT_INDEXED' };
        current = Number(kvVal);
      }
      if (!Number.isFinite(current)) return { status: 'NOT_INDEXED' };
      if (current < costUnits) return { status: 'INSUFFICIENT_CREDITS' };
      const rem = current - costUnits;
      localCreditBalances.set(creditKey, rem);
      await kv.put(`alpha402:credits:${creditKey}`, String(rem), { expirationTtl: NONCE_TTL_SECONDS });
      return { status: 'CLAIMED', remainingUnits: rem };
    } catch (e) {
      console.error('Cloudflare KV credit read/write error:', e);
    }
  }

  if (!localCreditBalances.has(creditKey)) {
    return { status: 'NOT_INDEXED' };
  }
  const current = localCreditBalances.get(creditKey)!;
  if (current < costUnits) {
    return { status: 'INSUFFICIENT_CREDITS' };
  }
  const rem = current - costUnits;
  localCreditBalances.set(creditKey, rem);
  return { status: 'CLAIMED', remainingUnits: rem };
}

/**
 * First-Use Prepaid Credit Initialization + Atomic Spend
 */
async function initAndSpendCredits(
  creditKey: string,
  totalDepositUnits: number,
  costUnits: number,
  ttlSeconds: number,
  env: Record<string, any>,
  _sandboxActive: boolean
): Promise<
  | { status: 'CLAIMED'; remainingUnits: number }
  | { status: 'INSUFFICIENT_CREDITS' }
  | { status: 'STORE_ERROR' }
> {
  const upstashUrl = env.UPSTASH_REDIS_REST_URL;
  const upstashToken = env.UPSTASH_REDIS_REST_TOKEN;

  if (upstashUrl && upstashToken) {
    const res = await upstashCommand(upstashUrl, upstashToken, [
      'EVAL',
      LUA_INIT_AND_SPEND,
      1,
      `alpha402:credits:${creditKey}`,
      totalDepositUnits,
      costUnits,
      ttlSeconds,
    ]);
    if (!res.ok || typeof res.result !== 'number') {
      return { status: 'STORE_ERROR' };
    }
    if (res.result < 0) {
      return { status: 'INSUFFICIENT_CREDITS' };
    }
    return { status: 'CLAIMED', remainingUnits: res.result };
  }

  let current = localCreditBalances.has(creditKey)
    ? localCreditBalances.get(creditKey)!
    : null;

  const kv = env.ALPHA402_KV;
  if (current === null && kv && typeof kv.get === 'function') {
    try {
      const kvVal = await kv.get(`alpha402:credits:${creditKey}`);
      if (kvVal !== null && Number.isFinite(Number(kvVal))) {
        current = Number(kvVal);
      }
    } catch {
      // Fall back to totalDepositUnits
    }
  }

  const startingUnits = current !== null ? current : totalDepositUnits;
  if (startingUnits < costUnits) {
    return { status: 'INSUFFICIENT_CREDITS' };
  }

  if (!localCreditBalances.has(creditKey) && localCreditBalances.size >= MAX_LOCAL_NONCES) {
    const oldest = localCreditBalances.keys().next().value;
    if (oldest !== undefined) localCreditBalances.delete(oldest);
  }

  const rem = startingUnits - costUnits;
  localCreditBalances.set(creditKey, rem);

  if (kv && typeof kv.put === 'function') {
    try {
      await kv.put(`alpha402:credits:${creditKey}`, String(rem), { expirationTtl: ttlSeconds });
    } catch (e) {
      console.error('Cloudflare KV credit init error:', e);
    }
  }

  return { status: 'CLAIMED', remainingUnits: rem };
}

/**
 * Atomic Distributed Nonce Settlement via Upstash Redis or Cloudflare KV (for single-use L402 & EIP-3009 proofs)
 */
async function atomicClaimNonce(
  nonceKey: string,
  ttlSeconds: number,
  env: Record<string, any>,
  _sandboxActive: boolean
): Promise<'CLAIMED' | 'ALREADY_SPENT' | 'STORE_ERROR'> {
  if (!nonceKey || nonceKey.length > 200 || !/^[a-zA-Z0-9:_-]+$/.test(nonceKey)) {
    return 'STORE_ERROR';
  }

  const upstashUrl = env.UPSTASH_REDIS_REST_URL;
  const upstashToken = env.UPSTASH_REDIS_REST_TOKEN;

  if (upstashUrl && upstashToken) {
    const res = await upstashCommand(upstashUrl, upstashToken, [
      'SET',
      `alpha402:nonce:${nonceKey}`,
      '1',
      'EX',
      ttlSeconds,
      'NX',
    ]);
    if (!res.ok) return 'STORE_ERROR';
    return res.result === 'OK' ? 'CLAIMED' : 'ALREADY_SPENT';
  }

  if (localSpentTokens.has(nonceKey)) {
    return 'ALREADY_SPENT';
  }

  const kv = env.ALPHA402_KV;
  if (kv && typeof kv.get === 'function') {
    try {
      const existing = await kv.get(`alpha402:nonce:${nonceKey}`);
      if (existing !== null) {
        localSpentTokens.add(nonceKey);
        return 'ALREADY_SPENT';
      }
      await kv.put(`alpha402:nonce:${nonceKey}`, '1', { expirationTtl: ttlSeconds });
    } catch (e) {
      console.error('Cloudflare KV nonce claim error:', e);
    }
  }

  if (localSpentTokens.size >= MAX_LOCAL_NONCES) {
    const oldest = localSpentTokens.values().next().value;
    if (oldest !== undefined) localSpentTokens.delete(oldest);
  }
  localSpentTokens.add(nonceKey);
  return 'CLAIMED';
}

/**
 * Rollback Nonce or Refund Prepaid Credits on Provider Failure
 * - For prepaid x402 credits (`x402:...`): atomically refunds `paymentCostUnits` via INCRBY / KV
 * - For free trial (`trial:...`): decrements daily trial usage so failed upstream calls never waste free quota
 * - For single-use L402 / EIP-3009 nonces: atomically deletes the nonce via DEL
 */
export async function releaseNonce(c: Context): Promise<boolean> {
  const paymentProof = c.get('paymentProof');
  if (!paymentProof || typeof paymentProof !== 'string') return false;

  const costUnits = Number(c.get('paymentCostUnits') || 0);
  const env = getEnv(c);
  const upstashUrl = env.UPSTASH_REDIS_REST_URL;
  const upstashToken = env.UPSTASH_REDIS_REST_TOKEN;
  const kv = env.ALPHA402_KV;

  if (paymentProof.startsWith('trial:')) {
    const used = localFreeTrialCounts.get(paymentProof) || 0;
    if (used > 0) {
      const nextUsed = used - 1;
      localFreeTrialCounts.set(paymentProof, nextUsed);
      if (kv && typeof kv.put === 'function') {
        try {
          await kv.put(`alpha402:${paymentProof}`, String(nextUsed), { expirationTtl: 86400 });
        } catch {
          // Ignore KV refund error
        }
      }
      const limit = Number(c.get('freeTrialLimit') || 3);
      c.set('freeTrialRemaining', Math.max(0, limit - nextUsed));
    }
    return true;
  }

  const isPrepaidCredit = paymentProof.startsWith('x402:') && costUnits > 0;

  if (upstashUrl && upstashToken) {
    if (isPrepaidCredit) {
      const res = await upstashCommand(upstashUrl, upstashToken, [
        'EVAL',
        LUA_REFUND_CREDITS,
        1,
        `alpha402:credits:${paymentProof}`,
        costUnits,
      ]);
      if (res.ok && typeof res.result === 'number' && res.result >= 0) {
        c.set('creditsRemainingUnits', res.result);
        c.set('creditsRemainingUsdc', Number((res.result / 1_000_000).toFixed(6)));
        c.set('callsRemaining', Math.floor(res.result / costUnits));
        return true;
      }
      return false;
    }

    const res = await upstashCommand(upstashUrl, upstashToken, [
      'DEL',
      `alpha402:nonce:${paymentProof}`,
    ]);
    return res.ok && typeof res.result === 'number' && res.result > 0;
  }

  if (isPrepaidCredit) {
    let currentBal = localCreditBalances.has(paymentProof)
      ? localCreditBalances.get(paymentProof)!
      : null;
    if (currentBal === null && kv && typeof kv.get === 'function') {
      try {
        const kvVal = await kv.get(`alpha402:credits:${paymentProof}`);
        if (kvVal !== null) currentBal = Number(kvVal);
      } catch {
        // Ignore
      }
    }
    if (currentBal === null || !Number.isFinite(currentBal)) return false;
    const newBal = currentBal + costUnits;
    localCreditBalances.set(paymentProof, newBal);
    if (kv && typeof kv.put === 'function') {
      try {
        await kv.put(`alpha402:credits:${paymentProof}`, String(newBal), {
          expirationTtl: NONCE_TTL_SECONDS,
        });
      } catch {
        // Ignore
      }
    }
    c.set('creditsRemainingUnits', newBal);
    c.set('creditsRemainingUsdc', Number((newBal / 1_000_000).toFixed(6)));
    c.set('callsRemaining', Math.floor(newBal / costUnits));
    return true;
  }

  localSpentTokens.delete(paymentProof);
  if (kv && typeof kv.delete === 'function') {
    try {
      await kv.delete(`alpha402:nonce:${paymentProof}`);
    } catch {
      // Ignore
    }
  }
  return true;
}

/**
 * Check remaining prepaid credit balance (or inspect an on-chain Base USDC deposit without spending)
 */
export async function inspectPrepaidCreditBalance(
  rawTxHash: string,
  c: Context
): Promise<{
  validFormat: boolean;
  indexed: boolean;
  onChainVerified: boolean;
  creditsRemainingUsdc: number;
  securityCallsRemaining: number;
  alphaCallsRemaining: number;
  polymarketCallsRemaining: number;
  message: string;
}> {
  const cleanHash = rawTxHash.replace(/^x402\s+/i, '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(cleanHash)) {
    return {
      validFormat: false,
      indexed: false,
      onChainVerified: false,
      creditsRemainingUsdc: 0,
      securityCallsRemaining: 0,
      alphaCallsRemaining: 0,
      polymarketCallsRemaining: 0,
      message: 'Invalid Base transaction hash format. Expected a 66-character 0x... hex hash.',
    };
  }

  const env = getEnv(c);
  const creditKey = `x402:${cleanHash}`;
  let units: number | null = localCreditBalances.has(creditKey)
    ? localCreditBalances.get(creditKey)!
    : null;

  if (units === null && env.ALPHA402_KV && typeof env.ALPHA402_KV.get === 'function') {
    try {
      const val = await env.ALPHA402_KV.get(`alpha402:credits:${creditKey}`);
      if (val !== null && Number.isFinite(Number(val))) {
        units = Number(val);
      }
    } catch {
      // Ignore
    }
  }

  if (units !== null) {
    const usdc = Number((units / 1_000_000).toFixed(6));
    return {
      validFormat: true,
      indexed: true,
      onChainVerified: true,
      creditsRemainingUsdc: usdc,
      securityCallsRemaining: Math.floor(units / 5_000),
      alphaCallsRemaining: Math.floor(units / 20_000),
      polymarketCallsRemaining: Math.floor(units / 10_000),
      message: `Active prepaid session found with $${usdc} USDC remaining.`,
    };
  }

  const recipientAddress = env.BASE_RECIPIENT_ADDRESS || DEFAULT_CONFIG.baseRecipientAddress;
  const rpcUrl = env.BASE_RPC_URL || DEFAULT_BASE_RPC_URL;
  const verification = await verifyBaseUsdcReceipt(cleanHash, recipientAddress, 5_000n, rpcUrl);

  if (!verification.verified || verification.totalUnits === undefined) {
    return {
      validFormat: true,
      indexed: false,
      onChainVerified: false,
      creditsRemainingUsdc: 0,
      securityCallsRemaining: 0,
      alphaCallsRemaining: 0,
      polymarketCallsRemaining: 0,
      message: verification.reason || 'Transaction could not be verified on Base.',
    };
  }

  const totalUnits = Number(
    verification.totalUnits > 10_000_000_000n ? 10_000_000_000n : verification.totalUnits
  );
  const usdc = Number((totalUnits / 1_000_000).toFixed(6));
  return {
    validFormat: true,
    indexed: false,
    onChainVerified: true,
    creditsRemainingUsdc: usdc,
    securityCallsRemaining: Math.floor(totalUnits / 5_000),
    alphaCallsRemaining: Math.floor(totalUnits / 20_000),
    polymarketCallsRemaining: Math.floor(totalUnits / 10_000),
    message: `Verified unspent on-chain deposit of $${usdc} USDC on Base! Pass paymentProof: "${cleanHash}" on any tool call to activate.`,
  };
}

/**
 * 3-Call Daily Free Trial for MCP Users & ?demo=true Evaluators
 */
async function tryConsumeFreeTrial(
  c: Context,
  env: Record<string, any>
): Promise<{ allowed: boolean; remaining: number; limit: number; trialKey: string }> {
  const limit = Math.max(0, Number(env.FREE_TRIAL_DAILY_LIMIT ?? 3));
  if (limit <= 0) {
    return { allowed: false, remaining: 0, limit: 0, trialKey: '' };
  }

  const dayKey = new Date().toISOString().slice(0, 10);
  const clientIp =
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    c.req.header('X-MCP-Client-ID') ||
    'default_mcp_client';
  const cleanClient = clientIp.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 64);
  const trialKey = `trial:${dayKey}:${cleanClient}`;

  let used: number | null = localFreeTrialCounts.has(trialKey)
    ? localFreeTrialCounts.get(trialKey)!
    : null;

  const kv = env.ALPHA402_KV;
  if (used === null && kv && typeof kv.get === 'function') {
    try {
      const kvVal = await kv.get(`alpha402:${trialKey}`);
      if (kvVal !== null && Number.isFinite(Number(kvVal))) {
        used = Number(kvVal);
      }
    } catch {
      // Ignore KV read error
    }
  }

  const currentUsed = used ?? 0;
  if (currentUsed >= limit) {
    return { allowed: false, remaining: 0, limit, trialKey };
  }

  const nextUsed = currentUsed + 1;
  localFreeTrialCounts.set(trialKey, nextUsed);
  if (kv && typeof kv.put === 'function') {
    try {
      await kv.put(`alpha402:${trialKey}`, String(nextUsed), { expirationTtl: 86400 });
    } catch {
      // Ignore KV write error
    }
  }

  return {
    allowed: true,
    remaining: Math.max(0, limit - nextUsed),
    limit,
    trialKey,
  };
}

/**
 * Official Coinbase x402 Protocol Payment Requirement Object (x402Version: 1)
 */
function buildCoinbaseX402Requirement(
  resourceUrl: string,
  recipientAddress: string,
  costUnits: number,
  description: string
) {
  return {
    scheme: 'exact',
    network: 'base',
    maxAmountRequired: costUnits.toString(),
    resource: resourceUrl,
    description,
    mimeType: 'application/json',
    payTo: recipientAddress,
    maxTimeoutSeconds: 60,
    asset: BASE_USDC_CONTRACT,
    extra: {
      name: 'USD Coin',
      version: '2',
      prepaidSupported: true,
    },
  };
}

/**
 * Official Coinbase x402 Facilitator Verification & Settlement
 * Supports EIP-3009 `transferWithAuthorization` payloads sent via the standard `X-PAYMENT` header
 * by `x402-fetch`, `x402-axios`, and Coinbase CDP AgentKit clients.
 */
async function verifyAndSettleCoinbaseX402(
  xPaymentHeaderB64: string,
  paymentRequirements: Record<string, any>,
  facilitatorUrl: string
): Promise<{
  verified: boolean;
  txHash?: string;
  nonceId?: string;
  reason?: string;
}> {
  let decoded: any;
  try {
    decoded = fromBase64Json(xPaymentHeaderB64);
  } catch {
    return { verified: false, reason: 'Invalid base64 encoding in X-PAYMENT header' };
  }

  if (!decoded || typeof decoded !== 'object') {
    return { verified: false, reason: 'Malformed JSON payload in X-PAYMENT header' };
  }

  // If the client wrapped an on-chain Base txHash inside X-PAYMENT JSON, let caller handle it via prepaid credits
  const embeddedTxHash = decoded?.payload?.txHash || decoded?.txHash;
  if (typeof embeddedTxHash === 'string' && /^0x[a-fA-F0-9]{64}$/.test(embeddedTxHash)) {
    return { verified: true, txHash: embeddedTxHash };
  }

  // Extract EIP-3009 authorization nonce to prevent replay before settling
  const authNonce =
    decoded?.payload?.authorization?.nonce ||
    decoded?.authorization?.nonce ||
    '';
  const cleanNonce = String(authNonce).replace(/[^a-zA-Z0-9_-]/g, '');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const verifyRes = await fetch(`${facilitatorUrl.replace(/\/$/, '')}/verify`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        x402Version: decoded.x402Version || 1,
        paymentHeader: xPaymentHeaderB64,
        paymentRequirements,
      }),
    });

    if (!verifyRes.ok) {
      return {
        verified: false,
        reason: `Coinbase x402 facilitator verify HTTP ${verifyRes.status}`,
      };
    }

    const verifyJson: any = await verifyRes.json();
    if (!verifyJson?.isValid) {
      return {
        verified: false,
        reason: verifyJson?.invalidReason || 'Coinbase x402 facilitator rejected payment signature',
      };
    }

    const settleRes = await fetch(`${facilitatorUrl.replace(/\/$/, '')}/settle`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        x402Version: decoded.x402Version || 1,
        paymentHeader: xPaymentHeaderB64,
        paymentRequirements,
      }),
    });

    if (!settleRes.ok) {
      return {
        verified: false,
        reason: `Coinbase x402 facilitator settle HTTP ${settleRes.status}`,
      };
    }

    const settleJson: any = await settleRes.json();
    if (!settleJson?.success && !settleJson?.txHash && !settleJson?.transaction) {
      return {
        verified: false,
        reason: settleJson?.error || 'Coinbase x402 facilitator settlement failed',
      };
    }

    const settledTx = String(settleJson.txHash || settleJson.transaction || '').toLowerCase();
    return {
      verified: true,
      txHash: settledTx || undefined,
      nonceId: cleanNonce || settledTx.replace(/^0x/, ''),
    };
  } catch (err: any) {
    return {
      verified: false,
      reason: `Coinbase x402 facilitator error: ${err?.message || 'Unknown error'}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * On-Chain Base RPC Receipt Verification (with automatic multi-RPC failover against HTTP 429)
 */
async function verifyBaseUsdcReceipt(
  txHash: string,
  expectedRecipient: string,
  minUnits: bigint,
  primaryRpcUrl: string
): Promise<{ verified: boolean; totalUnits?: bigint; reason?: string }> {
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return { verified: false, reason: 'Invalid transaction hash format' };
  }

  const rpcCandidates = Array.from(new Set([primaryRpcUrl, ...FALLBACK_BASE_RPC_URLS]));
  let lastErrorReason = 'Unable to reach Base RPC endpoints';

  for (const rpcUrl of rpcCandidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);

    try {
      const receiptRes = await fetch(rpcUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; Alpha402/1.6)',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getTransactionReceipt',
          params: [txHash],
        }),
      });

      if (!receiptRes.ok) {
        lastErrorReason = `Base RPC returned HTTP ${receiptRes.status}`;
        continue;
      }

      const receiptJson: any = await receiptRes.json();
      if (receiptJson?.error) {
        lastErrorReason = receiptJson?.error?.message || 'RPC JSON-RPC error';
        continue;
      }

      const receipt = receiptJson?.result;

      if (!receipt) {
        return { verified: false, reason: 'Transaction not found or not yet mined on Base' };
      }

      if (receipt.status !== '0x1') {
        return { verified: false, reason: 'Transaction reverted on-chain' };
      }

      const blockRes = await fetch(rpcUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; Alpha402/1.6)',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'eth_blockNumber',
          params: [],
        }),
      });

      if (!blockRes.ok) {
        lastErrorReason = `Base RPC blockNumber returned HTTP ${blockRes.status}`;
        continue;
      }

      const blockJson: any = await blockRes.json();
      const latestBlockHex = blockJson?.result;

      if (
        typeof receipt.blockNumber === 'string' &&
        /^0x[a-fA-F0-9]+$/.test(receipt.blockNumber) &&
        typeof latestBlockHex === 'string' &&
        /^0x[a-fA-F0-9]+$/.test(latestBlockHex)
      ) {
        const txBlock = BigInt(receipt.blockNumber);
        const currentBlock = BigInt(latestBlockHex);
        if (currentBlock > txBlock && currentBlock - txBlock > MAX_TX_AGE_BLOCKS) {
          return {
            verified: false,
            reason: 'Transaction receipt has expired (older than 24 hours / 43,200 blocks)',
          };
        }
      } else {
        lastErrorReason = 'Unable to verify transaction block age from RPC';
        continue;
      }

      const cleanRecipient = expectedRecipient.toLowerCase().replace(/^0x/, '');
      const paddedRecipient = '0x' + cleanRecipient.padStart(64, '0').toLowerCase();

      let totalTransferredUnits = 0n;

      for (const log of receipt.logs || []) {
        if (log?.address?.toLowerCase() === BASE_USDC_CONTRACT) {
          const topics = Array.isArray(log.topics) ? log.topics : [];
          if (
            topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC &&
            topics[2]?.toLowerCase() === paddedRecipient &&
            typeof log.data === 'string' &&
            /^0x[a-fA-F0-9]+$/.test(log.data)
          ) {
            totalTransferredUnits += BigInt(log.data);
          }
        }
      }

      if (totalTransferredUnits < minUnits) {
        return {
          verified: false,
          reason: `No matching USDC transfer >= ${minUnits} units found to ${expectedRecipient}`,
        };
      }

      return { verified: true, totalUnits: totalTransferredUnits };
    } catch (err: any) {
      lastErrorReason = `RPC verification failed: ${err?.message || 'Unknown RPC error'}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  return { verified: false, reason: lastErrorReason };
}

/**
 * Cryptographic L402 Token & Preimage Verification
 */
async function verifyL402Preimage(
  token: string,
  preimageHex: string,
  costSats: number,
  hmacSecret?: string
): Promise<{ verified: boolean; paymentHash?: string; reason?: string }> {
  if (!/^[a-fA-F0-9]{64}$/.test(preimageHex)) {
    return { verified: false, reason: 'Invalid preimage format: expected 64-character hex string' };
  }

  if (!hmacSecret) {
    return {
      verified: false,
      reason: 'L402 verification unavailable: server L402_HMAC_SECRET is not configured',
    };
  }

  const match = /^alpha402_(\d{10,15})_([a-fA-F0-9]{64})_([a-fA-F0-9]{64})$/.exec(token);
  if (!match) {
    return {
      verified: false,
      reason: 'Invalid or unsigned L402 challenge token format',
    };
  }

  const [, timestampStr, tokenPaymentHashRaw, tokenHmacRaw] = match;
  const timestamp = Number(timestampStr);
  const tokenPaymentHash = tokenPaymentHashRaw.toLowerCase();
  const tokenHmac = tokenHmacRaw.toLowerCase();

  const ageMs = Date.now() - timestamp;
  if (!Number.isFinite(ageMs) || ageMs < -30_000 || ageMs > L402_MAX_AGE_MS) {
    return { verified: false, reason: 'L402 challenge token has expired' };
  }

  try {
    const expectedHmac = await computeHmacSha256Hex(
      hmacSecret,
      `${timestampStr}:${tokenPaymentHash}:${costSats}`
    );
    if (!constantTimeEqual(tokenHmac, expectedHmac)) {
      return { verified: false, reason: 'Invalid L402 token HMAC signature' };
    }

    const bytes = new Uint8Array(preimageHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const computedHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    if (!constantTimeEqual(computedHash, tokenPaymentHash)) {
      return {
        verified: false,
        reason: 'Invalid preimage: SHA-256(preimage) does not match challenge payment hash',
      };
    }

    return { verified: true, paymentHash: computedHash };
  } catch {
    return { verified: false, reason: 'Cryptographic L402 verification failed' };
  }
}

export function paywall402(config: Partial<PaywallConfig> = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return async function (c: Context, next: Next) {
    const env = getEnv(c);
    const sandboxActive = cfg.enableSandbox || env.ENABLE_SANDBOX === 'true';
    const recipientAddress = env.BASE_RECIPIENT_ADDRESS || cfg.baseRecipientAddress;
    const rpcUrl = env.BASE_RPC_URL || DEFAULT_BASE_RPC_URL;
    const facilitatorUrl = env.X402_FACILITATOR_URL || DEFAULT_X402_FACILITATOR_URL;
    const costUnits = Math.round(cfg.costUsdc * 1_000_000); // e.g., 20,000 units for $0.02

    const paymentRequirement = buildCoinbaseX402Requirement(
      c.req.url,
      recipientAddress,
      costUnits,
      cfg.description || 'Alpha402 Fail-Closed On-Chain Intelligence'
    );

    // 1. Sandbox demo bypass (ONLY if sandbox is explicitly enabled)
    if (sandboxActive && c.req.query('demo') === 'true') {
      c.set('paymentType', 'demo_sandbox');
      return await next();
    }

    let xPaymentHeader =
      c.req.header('X-PAYMENT') ||
      c.req.header('x-payment') ||
      c.req.header('X-Payment-Proof') ||
      c.req.query('paymentProof') ||
      undefined;
    let authHeader = c.req.header('Authorization');

    if (xPaymentHeader && !authHeader) {
      const trimmedProof = xPaymentHeader.trim();
      if (trimmedProof.startsWith('x402 ') || trimmedProof.startsWith('L402 ')) {
        authHeader = trimmedProof;
        xPaymentHeader = undefined;
      }
    }

    // 2. Official Coinbase x402 `X-PAYMENT` Header Support (`x402-fetch`, `x402-axios`, CDP AgentKit)
    if (xPaymentHeader && !authHeader) {
      const trimmedXPayment = xPaymentHeader.trim();
      // Support raw txHash in X-PAYMENT as well as standard Base64 EIP-3009 JSON payload
      if (/^0x[a-fA-F0-9]{64}$/.test(trimmedXPayment) || /^TEST_TX_/.test(trimmedXPayment)) {
        authHeader = `x402 ${trimmedXPayment}`;
      } else {
        const cbVerification = await verifyAndSettleCoinbaseX402(
          trimmedXPayment,
          paymentRequirement,
          facilitatorUrl
        );

        if (!cbVerification.verified) {
          return c.json(
            {
              x402Version: 1,
              error: 'Payment Verification Failed',
              statusCode: 402,
              reason: cbVerification.reason,
              accepts: [paymentRequirement],
            },
            402
          );
        }

        // If client passed an on-chain Base txHash inside the X-PAYMENT JSON, route to prepaid credit engine
        if (cbVerification.txHash && !cbVerification.nonceId) {
          authHeader = `x402 ${cbVerification.txHash}`;
        } else {
          const nonceKey = `x402_cb:${cbVerification.nonceId || crypto.randomUUID().replace(/-/g, '')}`;
          const claimResult = await atomicClaimNonce(nonceKey, NONCE_TTL_SECONDS, env, sandboxActive);

          if (claimResult === 'STORE_ERROR') {
            return c.json(
              {
                error: 'Service Unavailable',
                statusCode: 503,
                reason: 'Replay protection store unreachable. Failing closed.',
              },
              503
            );
          }

          if (claimResult === 'ALREADY_SPENT') {
            return c.json(
              {
                x402Version: 1,
                error: 'Payment Required - Proof already redeemed',
                statusCode: 402,
                reason: 'Replay protection: This EIP-3009 authorization has already been consumed.',
                accepts: [paymentRequirement],
              },
              402
            );
          }

          c.set('paymentType', 'x402_Coinbase_Facilitator_Verified');
          c.set('paymentProof', nonceKey);
          c.set('paymentCostUnits', 0);

          c.header(
            'X-PAYMENT-RESPONSE',
            toBase64Json({
              success: true,
              txHash: cbVerification.txHash || null,
              networkId: 'base',
            })
          );

          await next();
          return;
        }
      }
    }

    // 3. Validate Payment if Authorization header is present
    if (authHeader) {
      // Check x402 EVM/Base format: "x402 <tx_hash>" (Supports both single-call $0.02 & multi-call prepaid deposits!)
      if (authHeader.startsWith('x402 ')) {
        const txHash = authHeader.slice(5).trim();
        let creditKey = '';
        let paymentType = '';
        let simulatedDepositUnits: number | null = null;

        // Sandbox simulated proofs ONLY permitted when sandboxActive === true
        // Format: TEST_TX_<id> (1 call) or TEST_TX_USD_<dollars>_<id> (multi-call prepaid test)
        if (sandboxActive && /^TEST_TX_[a-zA-Z0-9_.-]{1,64}$/.test(txHash)) {
          creditKey = `x402:sandbox:${txHash}`;
          paymentType = 'x402_Sandbox_Simulated';
          const multiMatch = /^TEST_TX_USD_(\d+(?:\.\d+)?)_/.exec(txHash);
          simulatedDepositUnits = multiMatch
            ? Math.round(parseFloat(multiMatch[1]) * 1_000_000)
            : costUnits;
        } else if (/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
          creditKey = `x402:${txHash.toLowerCase()}`;
          paymentType = 'x402_Base_USDC_OnChain_Verified';
        } else {
          return c.json(
            {
              x402Version: 1,
              error: 'Payment Verification Failed',
              statusCode: 402,
              reason: 'Invalid transaction hash format',
              accepts: [paymentRequirement],
            },
            402
          );
        }

        // STEP 3A: Fast-path Redis credit check (0 Base RPC calls if txHash was already verified!)
        const fastSpend = await trySpendExistingCredits(creditKey, costUnits, env, sandboxActive);

        if (fastSpend.status === 'STORE_ERROR') {
          return c.json(
            {
              error: 'Service Unavailable',
              statusCode: 503,
              reason: 'Replay protection and credit store unreachable. Failing closed to prevent double-spending.',
            },
            503
          );
        }

        if (fastSpend.status === 'INSUFFICIENT_CREDITS') {
          return c.json(
            {
              x402Version: 1,
              error: 'Payment Required - Proof or Prepaid Credit Exhausted',
              statusCode: 402,
              reason:
                'All credits from this transaction hash have been consumed. Send a new Base USDC transfer (e.g. $0.02 for 1 call or $1.00 for 50 instant calls).',
              accepts: [paymentRequirement],
            },
            402
          );
        }

        let remainingUnits = 0;

        if (fastSpend.status === 'CLAIMED') {
          remainingUnits = fastSpend.remainingUnits;
          if (paymentType === 'x402_Base_USDC_OnChain_Verified') {
            paymentType = 'x402_Base_USDC_Prepaid_Session_Instant';
          }
        } else {
          // STEP 3B: First time seeing this txHash -> Verify on Base RPC once and initialize credit balance!
          let totalDepositUnits = simulatedDepositUnits ?? 0;

          if (simulatedDepositUnits === null) {
            const minUsdcUnits = BigInt(costUnits);
            const verification = await verifyBaseUsdcReceipt(txHash, recipientAddress, minUsdcUnits, rpcUrl);

            if (!verification.verified || verification.totalUnits === undefined) {
              return c.json(
                {
                  x402Version: 1,
                  error: 'Payment Verification Failed',
                  statusCode: 402,
                  reason: verification.reason,
                  accepts: [paymentRequirement],
                },
                402
              );
            }

            const cappedUnits =
              verification.totalUnits > 10_000_000_000n ? 10_000_000_000n : verification.totalUnits;
            totalDepositUnits = Number(cappedUnits);
          }

          const initSpend = await initAndSpendCredits(
            creditKey,
            totalDepositUnits,
            costUnits,
            NONCE_TTL_SECONDS,
            env,
            sandboxActive
          );

          if (initSpend.status === 'STORE_ERROR') {
            return c.json(
              {
                error: 'Service Unavailable',
                statusCode: 503,
                reason: 'Replay protection and credit store unreachable. Failing closed to prevent double-spending.',
              },
              503
            );
          }

          if (initSpend.status === 'INSUFFICIENT_CREDITS') {
            return c.json(
              {
                x402Version: 1,
                error: 'Payment Required - Proof or Prepaid Credit Exhausted',
                statusCode: 402,
                reason: 'Insufficient USDC transferred for this endpoint tier.',
                accepts: [paymentRequirement],
              },
              402
            );
          }

          remainingUnits = initSpend.remainingUnits;
        }

        const remainingUsdc = Number((remainingUnits / 1_000_000).toFixed(6));
        const callsRemaining = Math.floor(remainingUnits / costUnits);

        c.set('paymentType', paymentType);
        c.set('paymentProof', creditKey);
        c.set('paymentCostUnits', costUnits);
        c.set('creditsRemainingUnits', remainingUnits);
        c.set('creditsRemainingUsdc', remainingUsdc);
        c.set('callsRemaining', callsRemaining);

        c.header('X-402-Credits-Remaining-USDC', remainingUsdc.toFixed(6));
        c.header('X-402-Calls-Remaining', callsRemaining.toString());
        c.header(
          'X-PAYMENT-RESPONSE',
          toBase64Json({
            success: true,
            txHash: txHash.startsWith('0x') ? txHash.toLowerCase() : txHash,
            networkId: 'base',
            creditsRemainingUsdc: remainingUsdc,
            callsRemaining,
          })
        );

        await next();
        return;
      }

      // Check L402 format: "L402 <token>:<preimage>"
      if (authHeader.startsWith('L402 ')) {
        const credentials = authHeader.slice(5).trim();
        const colonIdx = credentials.indexOf(':');
        const token = colonIdx > 0 ? credentials.slice(0, colonIdx).trim() : '';
        const preimage = colonIdx > 0 ? credentials.slice(colonIdx + 1).trim() : '';

        if (!token || !preimage) {
          return c.json(
            {
              x402Version: 1,
              error: 'Payment Verification Failed',
              statusCode: 402,
              reason: 'Malformed L402 header. Expected format: "Authorization: L402 <token>:<preimage>"',
              accepts: [paymentRequirement],
            },
            402
          );
        }

        let paymentProof = '';
        let paymentType = '';

        if (
          sandboxActive &&
          preimage === 'TEST_PREIMAGE_OK' &&
          /^[a-zA-Z0-9_-]{8,160}$/.test(token)
        ) {
          paymentProof = `l402:sandbox:${token}`;
          paymentType = 'L402_Sandbox_Simulated';
        } else {
          const verification = await verifyL402Preimage(
            token,
            preimage,
            cfg.costSats,
            env.L402_HMAC_SECRET
          );
          if (!verification.verified || !verification.paymentHash) {
            return c.json(
              {
                x402Version: 1,
                error: 'Payment Verification Failed',
                statusCode: 402,
                reason: verification.reason || 'Invalid L402 payment proof',
                accepts: [paymentRequirement],
              },
              402
            );
          }
          paymentProof = `l402:${verification.paymentHash}`;
          paymentType = 'L402_Lightning_Cryptographic_Verified';
        }

        const claimResult = await atomicClaimNonce(paymentProof, NONCE_TTL_SECONDS, env, sandboxActive);

        if (claimResult === 'STORE_ERROR') {
          return c.json(
            {
              error: 'Service Unavailable',
              statusCode: 503,
              reason: 'Replay protection store unreachable. Failing closed to prevent unverified double-spending.',
            },
            503
          );
        }

        if (claimResult === 'ALREADY_SPENT') {
          return c.json(
            {
              x402Version: 1,
              error: 'Payment Required - Proof already redeemed',
              statusCode: 402,
              reason: 'Replay protection: This payment proof has already been consumed.',
              accepts: [paymentRequirement],
            },
            402
          );
        }

        c.set('paymentType', paymentType);
        c.set('paymentProof', paymentProof);
        c.set('paymentCostUnits', 0);

        await next();
        return;
      }

      return c.json(
        {
          x402Version: 1,
          error: 'Payment Verification Failed',
          statusCode: 402,
          reason: 'Unsupported Authorization scheme. Use "X-PAYMENT: <base64>", "Authorization: x402 <tx_hash>", or "Authorization: L402 <token>:<preimage>".',
          accepts: [paymentRequirement],
        },
        402
      );
    }

    // 3.5. Automatic 3-Call Daily Free Trial for MCP Clients & ?demo=true Evaluators
    const wantsFreeTrial =
      c.req.query('demo') === 'true' ||
      c.req.header('X-MCP-Trial') === 'true' ||
      c.req.header('x-mcp-trial') === 'true';

    if (wantsFreeTrial) {
      const trial = await tryConsumeFreeTrial(c, env);
      if (trial.allowed) {
        c.set('paymentType', 'free_trial_3_daily');
        c.set('paymentProof', trial.trialKey);
        c.set('paymentCostUnits', 0);
        c.set('freeTrialRemaining', trial.remaining);
        c.set('freeTrialLimit', trial.limit);
        c.header('X-402-Free-Trial-Remaining', String(trial.remaining));
        c.header('X-402-Upgrade-Recipient', recipientAddress);
        await next();
        return;
      }
    }

    // 4. No valid payment presented -> Issue HTTP 402 challenge (Compatible with Coinbase x402 v1, Prepaid x402, and L402)
    await recordAnalyticsEvent(
      {
        endpoint: new URL(c.req.url).pathname,
        outcome: 'PAYWALL_402',
      },
      env.ALPHA402_KV
    );

    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    const challengeHash = Array.from(randomBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const now = Date.now();

    const requestId = env.L402_HMAC_SECRET
      ? await createSignedL402Token(now, challengeHash, cfg.costSats, env.L402_HMAC_SECRET)
      : `alpha402_${now}_${challengeHash.slice(0, 16)}`;
    const mockInvoice = `lnbc${cfg.costSats}0n1p3xxxx...${challengeHash.slice(0, 16)}`;

    c.header('WWW-Authenticate', `L402 token="${requestId}", invoice="${mockInvoice}"`);
    c.header('X-402-Cost-USDC', cfg.costUsdc.toString());
    c.header('X-402-Cost-Sats', cfg.costSats.toString());
    c.header('X-402-Payment-Recipient', recipientAddress);

    return c.json(
      {
        x402Version: 1,
        accepts: [paymentRequirement],
        error: 'Payment Required',
        statusCode: 402,
        message:
          'This API requires micro-payment from your AI Agent wallet. Supports Coinbase x402 (X-PAYMENT header), Prepaid Base USDC (Authorization: x402 <tx_hash>), and Lightning L402.',
        pricing: {
          costUsdc: cfg.costUsdc,
          costSats: cfg.costSats,
          prepaidBundles: {
            '$0.02 USDC': '1 token-alpha call (or 4 security-only calls)',
            '$1.00 USDC': '50 instant token-alpha calls (or 200 security-only calls) on the same tx_hash',
            '$5.00 USDC': '250 instant token-alpha calls (or 1,000 security-only calls) on the same tx_hash',
          },
        },
        paymentOptions: {
          coinbaseX402: {
            protocol: 'Official Coinbase x402 (EIP-3009 / x402-fetch / CDP AgentKit)',
            headerFormat: 'X-PAYMENT: <base64_x402_payload>',
            facilitator: facilitatorUrl,
          },
          x402: {
            protocol: 'EVM / Base USDC (Single-Call or Multi-Call Prepaid Deposit)',
            network: 'base',
            amountUsdc: cfg.costUsdc,
            usdcContract: BASE_USDC_CONTRACT,
            recipient: recipientAddress,
            settleFormat: 'Authorization: x402 <transaction_hash>',
            prepaidNote:
              'Deposit any amount >= costUsdc in one Base USDC transfer and reuse the same tx_hash across requests with zero RPC latency until your credit balance reaches 0.',
          },
          l402: {
            protocol: 'Lightning Network',
            token: requestId,
            invoice: mockInvoice,
            settleFormat: 'Authorization: L402 <token>:<preimage>',
          },
        },
      },
      402
    );
  };
}
