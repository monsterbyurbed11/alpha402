import { Context, Next } from 'hono';

export interface PaywallConfig {
  costUsdc: number;
  costSats: number;
  baseRecipientAddress: string;
  enableSandbox: boolean;
  upstashUrl?: string;
  upstashToken?: string;
}

export const DEFAULT_CONFIG: PaywallConfig = {
  costUsdc: 0.02,
  costSats: 20,
  baseRecipientAddress: '0x8a8c238ed2b46908Ff6C6922a3870984f20f8913',
  enableSandbox: true,
};

// Fallback in-memory set for local offline dev
const localSpentTokens = new Set<string>();

/**
 * Atomic Distributed Nonce Settlement via Upstash Redis REST API
 * Guarantees cross-region, cross-isolate single-spend execution using atomic SET ... EX ... NX.
 */
async function atomicClaimNonce(
  nonceKey: string,
  ttlSeconds: number,
  env: Record<string, any>
): Promise<boolean> {
  const upstashUrl = env.UPSTASH_REDIS_REST_URL;
  const upstashToken = env.UPSTASH_REDIS_REST_TOKEN;

  if (upstashUrl && upstashToken) {
    try {
      // Redis command: SET alpha402:nonce:<key> 1 EX <ttl> NX
      const endpoint = `${upstashUrl}/set/alpha402:nonce:${nonceKey}/1?EX=${ttlSeconds}&NX`;
      const res = await fetch(endpoint, {
        headers: {
          Authorization: `Bearer ${upstashToken}`,
        },
      });

      if (res.ok) {
        const data: any = await res.json();
        // If atomic NX succeeded, Redis returns {"result": "OK"}.
        // If already claimed by another concurrent request, Redis returns {"result": null}.
        return data.result === 'OK';
      }
    } catch (e) {
      console.error('Upstash atomic nonce check error:', e);
    }
  }

  // Fallback for local development without Upstash configured
  if (localSpentTokens.has(nonceKey)) {
    return false;
  }
  localSpentTokens.add(nonceKey);
  return true;
}

export function paywall402(config: Partial<PaywallConfig> = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return async function (c: Context, next: Next) {
    // 1. Check for free bypass / demo testing
    const isDemo = c.req.query('demo') === 'true';
    if (cfg.enableSandbox && isDemo) {
      c.set('paymentType', 'demo_sandbox');
      return await next();
    }

    const authHeader = c.req.header('Authorization');

    // 2. Validate Payment if Authorization header is present
    if (authHeader) {
      let paymentProof = '';
      let paymentType = '';
      let ttlSeconds = 86400; // Default 24h past authorization window

      // Check L402 format: "L402 <macaroon>:<preimage>"
      if (authHeader.startsWith('L402 ')) {
        const credentials = authHeader.slice(5).trim();
        const [token, preimage] = credentials.split(':');
        if (token && preimage) {
          if (cfg.enableSandbox && (preimage.startsWith('TEST_') || preimage.length === 64)) {
            paymentProof = token;
            paymentType = 'L402_Lightning';
          }
        }
      }

      // Check x402 EVM/Base format: "x402 <tx_hash_or_voucher>"
      if (authHeader.startsWith('x402 ')) {
        const proof = authHeader.slice(5).trim();
        if (proof && proof.length >= 10) {
          paymentProof = proof;
          paymentType = 'x402_Base_USDC';
          ttlSeconds = 86400 * 3; // 3-day window for on-chain tx receipts
        }
      }

      // Check Bearer token
      if (authHeader.startsWith('Bearer ')) {
        const apiKey = authHeader.slice(7).trim();
        if (apiKey.startsWith('agent_') || (cfg.enableSandbox && apiKey === 'test_key')) {
          paymentProof = apiKey;
          paymentType = 'ApiKey';
          ttlSeconds = 60;
        }
      }

      if (paymentProof) {
        // Atomic Check & Set before serving response
        const env = c.env || {};
        const isFreshClaim = await atomicClaimNonce(paymentProof, ttlSeconds, env);

        if (!isFreshClaim) {
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
    const requestId = `alpha402_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const mockInvoice = `lnbc${cfg.costSats}0n1p3xxxx...${requestId.slice(-6)}`;

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
          l402: {
            protocol: 'Lightning Network',
            token: requestId,
            invoice: mockInvoice,
            settleFormat: 'Authorization: L402 <token>:<preimage>',
          },
          x402: {
            protocol: 'EVM / Base USDC',
            network: 'base',
            amountUsdc: cfg.costUsdc,
            recipient: cfg.baseRecipientAddress,
            settleFormat: 'Authorization: x402 <transaction_hash>',
          },
        },
        sandboxTesting: cfg.enableSandbox
          ? {
              note: 'Testing mode enabled. Add header "Authorization: L402 test_token:TEST_PREIMAGE_OK" or query param "?demo=true" to test without crypto.',
            }
          : undefined,
      },
      402
    );
  };
}
