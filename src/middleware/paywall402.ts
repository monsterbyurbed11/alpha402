import { Context, Next } from 'hono';

export interface PaywallConfig {
  costUsdc: number; // e.g. 0.02 ($0.02)
  costSats: number; // e.g. 20 sats
  baseRecipientAddress: string;
  enableSandbox: boolean; // MUST default to false in production
}

export const DEFAULT_CONFIG: PaywallConfig = {
  costUsdc: 0.02,
  costSats: 20,
  baseRecipientAddress: '0x8a8c238ed2b46908Ff6C6922a3870984f20f8913',
  enableSandbox: false, // Default: FALSE. Zero free bypass.
};

const BASE_USDC_CONTRACT = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEFAULT_BASE_RPC_URL = 'https://mainnet.base.org';

// Maximum age for on-chain Base USDC transaction receipts: 43,200 blocks (~24 hours at 2s/block).
// Combined with a 7-day Redis nonce TTL, this guarantees transactions can NEVER be replayed after TTL expiry.
const MAX_TX_AGE_BLOCKS = 43200n;
const NONCE_TTL_SECONDS = 86400 * 7; // 7 days
const L402_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

// Local dev set ONLY used when explicitly running offline with sandbox enabled (bounded to prevent memory DoS)
const MAX_LOCAL_NONCES = 10000;
const localSpentTokens = new Set<string>();

function getEnv(c: Context): Record<string, any> {
  const nodeEnv = typeof process !== 'undefined' && process.env ? process.env : {};
  const workerEnv = c.env && typeof c.env === 'object' ? c.env : {};
  return { ...nodeEnv, ...workerEnv };
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

/**
 * Atomic Distributed Nonce Settlement via Upstash Redis REST POST
 * Sends JSON command array to eliminate any REST path URL injection.
 * Fails closed with 503 if Redis is unreachable or non-200.
 */
async function atomicClaimNonce(
  nonceKey: string,
  ttlSeconds: number,
  env: Record<string, any>,
  sandboxActive: boolean
): Promise<'CLAIMED' | 'ALREADY_SPENT' | 'STORE_ERROR'> {
  if (!nonceKey || nonceKey.length > 200 || !/^[a-zA-Z0-9:_-]+$/.test(nonceKey)) {
    return 'STORE_ERROR';
  }

  const upstashUrl = env.UPSTASH_REDIS_REST_URL;
  const upstashToken = env.UPSTASH_REDIS_REST_TOKEN;

  if (upstashUrl && upstashToken) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      // POST command array: ["SET", key, "1", "EX", ttl, "NX"]
      const res = await fetch(upstashUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${upstashToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(['SET', `alpha402:nonce:${nonceKey}`, '1', 'EX', ttlSeconds, 'NX']),
      });

      if (!res.ok) {
        console.error(`Upstash Redis error: HTTP ${res.status}`);
        return 'STORE_ERROR'; // Fail closed!
      }

      const data: any = await res.json();
      return data?.result === 'OK' ? 'CLAIMED' : 'ALREADY_SPENT';
    } catch (e) {
      console.error('Upstash atomic nonce check error:', e);
      return 'STORE_ERROR'; // Fail closed!
    } finally {
      clearTimeout(timeout);
    }
  }

  // If Upstash is not configured: only allow if sandbox is explicitly active
  if (sandboxActive) {
    if (localSpentTokens.has(nonceKey)) {
      return 'ALREADY_SPENT';
    }
    if (localSpentTokens.size >= MAX_LOCAL_NONCES) {
      const oldest = localSpentTokens.values().next().value;
      if (oldest !== undefined) localSpentTokens.delete(oldest);
    }
    localSpentTokens.add(nonceKey);
    return 'CLAIMED';
  }

  // Production with no Redis configured MUST fail closed
  console.error('FATAL: UPSTASH_REDIS_REST_URL not configured in production. Failing closed.');
  return 'STORE_ERROR';
}

/**
 * Rollback Nonce on Provider Failure via POST ["DEL", key]
 * Does NOT swallow errors: returns boolean reflecting actual Redis status.
 */
export async function releaseNonce(c: Context): Promise<boolean> {
  const paymentProof = c.get('paymentProof');
  if (!paymentProof || typeof paymentProof !== 'string') return false;

  const env = getEnv(c);
  const upstashUrl = env.UPSTASH_REDIS_REST_URL;
  const upstashToken = env.UPSTASH_REDIS_REST_TOKEN;

  if (upstashUrl && upstashToken) {
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
        body: JSON.stringify(['DEL', `alpha402:nonce:${paymentProof}`]),
      });

      if (res.ok) {
        const data: any = await res.json();
        return typeof data?.result === 'number' && data.result > 0;
      }
      return false; // Upstash returned error, do not pretend it succeeded
    } catch (e) {
      console.error('Failed to release nonce in Upstash:', e);
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  if (env.ENABLE_SANDBOX === 'true') {
    return localSpentTokens.delete(paymentProof);
  }

  return false;
}

/**
 * On-Chain Base RPC Receipt Verification
 * Verifies that the transaction was mined within the last 24h (43,200 blocks),
 * succeeded against Base USDC, transferred >= minUnits, and paid the merchant address.
 */
async function verifyBaseUsdcReceipt(
  txHash: string,
  expectedRecipient: string,
  minUnits: bigint,
  rpcUrl: string
): Promise<{ verified: boolean; reason?: string }> {
  // Validate txHash format: 0x followed by 64 hex chars
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return { verified: false, reason: 'Invalid transaction hash format' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const [receiptRes, blockRes] = await Promise.all([
      fetch(rpcUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getTransactionReceipt',
          params: [txHash],
        }),
      }),
      fetch(rpcUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'eth_blockNumber',
          params: [],
        }),
      }),
    ]);

    if (!receiptRes.ok || !blockRes.ok) {
      return { verified: false, reason: `Base RPC returned HTTP ${receiptRes.status}/${blockRes.status}` };
    }

    const [{ result: receipt }, { result: latestBlockHex }] = (await Promise.all([
      receiptRes.json(),
      blockRes.json(),
    ])) as any[];

    if (!receipt) {
      return { verified: false, reason: 'Transaction not found or not yet mined on Base' };
    }

    if (receipt.status !== '0x1') {
      return { verified: false, reason: 'Transaction reverted on-chain' };
    }

    // Verify transaction block age to prevent replaying old transactions after Redis TTL expires
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
      return { verified: false, reason: 'Unable to verify transaction block age from RPC' };
    }

    // Padded 32-byte recipient topic
    const cleanRecipient = expectedRecipient.toLowerCase().replace(/^0x/, '');
    const paddedRecipient = '0x' + cleanRecipient.padStart(64, '0').toLowerCase();

    // Scan logs for Transfer(from, to, value) on Base USDC
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

    return { verified: true };
  } catch (err: any) {
    return { verified: false, reason: `RPC verification failed: ${err?.message || 'Unknown RPC error'}` };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Cryptographic L402 Token & Preimage Verification
 * 1. Computes full 256-bit SHA-256(preimage)
 * 2. Verifies server HMAC-SHA256 signature on token to prevent client-side token forgery
 * 3. Verifies token timestamp is within 1-hour validity window
 * 4. Returns canonical paymentHash to use as replay-protection nonce key
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

  // Strict token format: alpha402_<timestamp>_<paymentHash64>_<hmac64>
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

  // Check token expiration (1 hour window, max 30s clock skew)
  const ageMs = Date.now() - timestamp;
  if (!Number.isFinite(ageMs) || ageMs < -30_000 || ageMs > L402_MAX_AGE_MS) {
    return { verified: false, reason: 'L402 challenge token has expired' };
  }

  try {
    // 1. Verify HMAC-SHA256 signature so clients cannot forge their own paymentHash tokens
    const expectedHmac = await computeHmacSha256Hex(
      hmacSecret,
      `${timestampStr}:${tokenPaymentHash}:${costSats}`
    );
    if (!constantTimeEqual(tokenHmac, expectedHmac)) {
      return { verified: false, reason: 'Invalid L402 token HMAC signature' };
    }

    // 2. Verify SHA-256(preimage) === tokenPaymentHash (full 256-bit comparison)
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

    // 1. Sandbox demo bypass (ONLY if sandbox is explicitly enabled)
    if (sandboxActive && c.req.query('demo') === 'true') {
      c.set('paymentType', 'demo_sandbox');
      return await next();
    }

    const authHeader = c.req.header('Authorization');

    // 2. Validate Payment if Authorization header is present
    if (authHeader) {
      let paymentProof = '';
      let paymentType = '';

      // Check x402 EVM/Base format: "x402 <tx_hash>"
      if (authHeader.startsWith('x402 ')) {
        const txHash = authHeader.slice(5).trim();

        // Sandbox simulated proofs ONLY permitted when sandboxActive === true
        if (sandboxActive && /^TEST_TX_[a-zA-Z0-9_-]{1,64}$/.test(txHash)) {
          paymentProof = `x402:sandbox:${txHash}`;
          paymentType = 'x402_Sandbox_Simulated';
        } else {
          // REAL PRODUCTION VERIFICATION: Query Base RPC
          const minUsdcUnits = BigInt(Math.round(cfg.costUsdc * 1_000_000)); // 20,000 units for $0.02
          const verification = await verifyBaseUsdcReceipt(txHash, recipientAddress, minUsdcUnits, rpcUrl);

          if (!verification.verified) {
            return c.json(
              {
                error: 'Payment Verification Failed',
                statusCode: 402,
                reason: verification.reason,
              },
              402
            );
          }

          paymentProof = `x402:${txHash.toLowerCase()}`;
          paymentType = 'x402_Base_USDC_OnChain_Verified';
        }
      } else if (authHeader.startsWith('L402 ')) {
        // Check L402 format: "L402 <token>:<preimage>"
        const credentials = authHeader.slice(5).trim();
        const colonIdx = credentials.indexOf(':');
        const token = colonIdx > 0 ? credentials.slice(0, colonIdx).trim() : '';
        const preimage = colonIdx > 0 ? credentials.slice(colonIdx + 1).trim() : '';

        if (!token || !preimage) {
          return c.json(
            {
              error: 'Payment Verification Failed',
              statusCode: 402,
              reason: 'Malformed L402 header. Expected format: "Authorization: L402 <token>:<preimage>"',
            },
            402
          );
        }

        if (
          sandboxActive &&
          preimage === 'TEST_PREIMAGE_OK' &&
          /^[a-zA-Z0-9_-]{8,160}$/.test(token)
        ) {
          paymentProof = `l402:sandbox:${token}`;
          paymentType = 'L402_Sandbox_Simulated';
        } else {
          // Cryptographic HMAC + SHA-256 verification
          const verification = await verifyL402Preimage(
            token,
            preimage,
            cfg.costSats,
            env.L402_HMAC_SECRET
          );
          if (!verification.verified || !verification.paymentHash) {
            return c.json(
              {
                error: 'Payment Verification Failed',
                statusCode: 402,
                reason: verification.reason || 'Invalid L402 payment proof',
              },
              402
            );
          }
          // Canonical nonce key is the paymentHash itself so token string mutations cannot replay a preimage
          paymentProof = `l402:${verification.paymentHash}`;
          paymentType = 'L402_Lightning_Cryptographic_Verified';
        }
      } else {
        return c.json(
          {
            error: 'Payment Verification Failed',
            statusCode: 402,
            reason: 'Unsupported Authorization scheme. Use "x402 <tx_hash>" or "L402 <token>:<preimage>".',
          },
          402
        );
      }

      if (paymentProof) {
        // Atomic Check & Set before serving response
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
              error: 'Payment Required - Proof already redeemed',
              statusCode: 402,
              reason: 'Replay protection: This payment proof or transaction hash has already been consumed.',
            },
            402
          );
        }

        c.set('paymentType', paymentType);
        c.set('paymentProof', paymentProof);

        await next();
        return;
      }
    }

    // 3. No valid payment presented -> Issue HTTP 402 challenge
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
        error: 'Payment Required',
        statusCode: 402,
        message: 'This API requires micro-payment from your AI Agent wallet.',
        pricing: {
          costUsdc: cfg.costUsdc,
          costSats: cfg.costSats,
        },
        paymentOptions: {
          x402: {
            protocol: 'EVM / Base USDC',
            network: 'base',
            amountUsdc: cfg.costUsdc,
            usdcContract: BASE_USDC_CONTRACT,
            recipient: recipientAddress,
            settleFormat: 'Authorization: x402 <transaction_hash>',
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
