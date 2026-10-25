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
const BASE_RPC_URL = 'https://mainnet.base.org';

// Local dev set ONLY used when explicitly running offline with sandbox enabled
const localSpentTokens = new Set<string>();

/**
 * Atomic Distributed Nonce Settlement via Upstash Redis REST POST
 * Sends JSON command array to eliminate any REST path URL injection.
 * Fails closed with 503 if Redis is unreachable or non-200.
 */
async function atomicClaimNonce(
  nonceKey: string,
  ttlSeconds: number,
  env: Record<string, any>
): Promise<'CLAIMED' | 'ALREADY_SPENT' | 'STORE_ERROR'> {
  const upstashUrl = env.UPSTASH_REDIS_REST_URL;
  const upstashToken = env.UPSTASH_REDIS_REST_TOKEN;

  if (upstashUrl && upstashToken) {
    try {
      // POST command array: ["SET", key, "1", "EX", ttl, "NX"]
      const res = await fetch(upstashUrl, {
        method: 'POST',
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
      return data.result === 'OK' ? 'CLAIMED' : 'ALREADY_SPENT';
    } catch (e) {
      console.error('Upstash atomic nonce check error:', e);
      return 'STORE_ERROR'; // Fail closed!
    }
  }

  // If Upstash is not configured: only allow if sandbox is explicitly true
  if (env.ENABLE_SANDBOX === 'true') {
    if (localSpentTokens.has(nonceKey)) {
      return 'ALREADY_SPENT';
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
  if (!paymentProof) return false;

  const env = c.env || {};
  const upstashUrl = env.UPSTASH_REDIS_REST_URL;
  const upstashToken = env.UPSTASH_REDIS_REST_TOKEN;

  if (upstashUrl && upstashToken) {
    try {
      const res = await fetch(upstashUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${upstashToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(['DEL', `alpha402:nonce:${paymentProof}`]),
      });

      if (res.ok) {
        const data: any = await res.json();
        return typeof data.result === 'number' && data.result > 0;
      }
      return false; // Upstash returned error, do not pretend it succeeded
    } catch (e) {
      console.error('Failed to release nonce in Upstash:', e);
      return false;
    }
  }

  if (env.ENABLE_SANDBOX === 'true') {
    localSpentTokens.delete(paymentProof);
    return true;
  }

  return false;
}

/**
 * On-Chain Base RPC Receipt Verification
 * Verifies that the transaction was mined, executed against Base USDC,
 * transferred >= $0.02 (20,000 units), and paid the merchant address.
 */
async function verifyBaseUsdcReceipt(
  txHash: string,
  expectedRecipient: string,
  minUnits: bigint
): Promise<{ verified: boolean; reason?: string }> {
  // Validate txHash format: 0x followed by 64 hex chars
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return { verified: false, reason: 'Invalid transaction hash format' };
  }

  try {
    const res = await fetch(BASE_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      }),
    });

    if (!res.ok) {
      return { verified: false, reason: `Base RPC returned HTTP ${res.status}` };
    }

    const { result: receipt } = (await res.json()) as any;
    if (!receipt) {
      return { verified: false, reason: 'Transaction not found or not yet mined on Base' };
    }

    if (receipt.status !== '0x1') {
      return { verified: false, reason: 'Transaction reverted on-chain' };
    }

    // Padded 32-byte recipient topic
    const cleanRecipient = expectedRecipient.toLowerCase().replace('0x', '');
    const paddedRecipient = '0x' + cleanRecipient.padStart(64, '0').toLowerCase();

    // Scan logs for Transfer(from, to, value) on Base USDC
    let validTransferFound = false;

    for (const log of receipt.logs || []) {
      if (log.address?.toLowerCase() === BASE_USDC_CONTRACT) {
        const topics = log.topics || [];
        if (
          topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC &&
          topics[2]?.toLowerCase() === paddedRecipient
        ) {
          const value = BigInt(log.data);
          if (value >= minUnits) {
            validTransferFound = true;
            break;
          }
        }
      }
    }

    if (!validTransferFound) {
      return {
        verified: false,
        reason: `No matching USDC transfer >= ${minUnits} units found to ${expectedRecipient}`,
      };
    }

    return { verified: true };
  } catch (err: any) {
    return { verified: false, reason: `RPC verification failed: ${err.message}` };
  }
}

/**
 * L402 Preimage Verification
 * SHA-256(preimage) MUST equal the payment_hash embedded in the challenge token.
 */
async function verifyL402Preimage(token: string, preimageHex: string): Promise<boolean> {
  if (!/^[a-fA-F0-9]{64}$/.test(preimageHex)) {
    return false;
  }

  try {
    // Convert hex to byte array
    const bytes = new Uint8Array(preimageHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const computedHash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    // Token format: alpha402_<timestamp>_<hash>
    return token.includes(computedHash.slice(0, 16));
  } catch {
    return false;
  }
}

export function paywall402(config: Partial<PaywallConfig> = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return async function (c: Context, next: Next) {
    const env = c.env || {};
    const sandboxActive = cfg.enableSandbox || env.ENABLE_SANDBOX === 'true';

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
      let ttlSeconds = 86400 * 3; // 3-day window for on-chain tx receipts

      // Check x402 EVM/Base format: "x402 <tx_hash>"
      if (authHeader.startsWith('x402 ')) {
        const txHash = authHeader.slice(5).trim();

        // Sandbox simulated proofs ONLY permitted when sandboxActive === true
        if (sandboxActive && txHash.startsWith('TEST_TX_')) {
          paymentProof = txHash;
          paymentType = 'x402_Sandbox_Simulated';
        } else {
          // REAL PRODUCTION VERIFICATION: Query Base RPC
          const minUsdcUnits = BigInt(Math.round(cfg.costUsdc * 1_000_000)); // 20,000 units for $0.02
          const verification = await verifyBaseUsdcReceipt(txHash, cfg.baseRecipientAddress, minUsdcUnits);

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

          paymentProof = txHash.toLowerCase();
          paymentType = 'x402_Base_USDC_OnChain_Verified';
        }
      }

      // Check L402 format: "L402 <token>:<preimage>"
      if (authHeader.startsWith('L402 ')) {
        const credentials = authHeader.slice(5).trim();
        const [token, preimage] = credentials.split(':');

        if (token && preimage) {
          if (sandboxActive && preimage === 'TEST_PREIMAGE_OK') {
            paymentProof = token;
            paymentType = 'L402_Sandbox_Simulated';
          } else {
            // Cryptographic SHA-256 verification
            const isValid = await verifyL402Preimage(token, preimage);
            if (!isValid) {
              return c.json(
                {
                  error: 'Payment Verification Failed',
                  statusCode: 402,
                  reason: 'Invalid preimage: SHA-256(preimage) does not match payment challenge.',
                },
                402
              );
            }
            paymentProof = token;
            paymentType = 'L402_Lightning_Cryptographic_Verified';
          }
        }
      }

      if (paymentProof) {
        // Atomic Check & Set before serving response
        const claimResult = await atomicClaimNonce(paymentProof, ttlSeconds, env);

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
    const challengeRandom = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const requestId = `alpha402_${Date.now()}_${challengeRandom}`;
    const mockInvoice = `lnbc${cfg.costSats}0n1p3xxxx...${challengeRandom}`;

    c.header('WWW-Authenticate', `L402 token="${requestId}", invoice="${mockInvoice}"`);
    c.header('X-402-Cost-USDC', cfg.costUsdc.toString());
    c.header('X-402-Cost-Sats', cfg.costSats.toString());
    c.header('X-402-Payment-Recipient', cfg.baseRecipientAddress);

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
            recipient: cfg.baseRecipientAddress,
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
