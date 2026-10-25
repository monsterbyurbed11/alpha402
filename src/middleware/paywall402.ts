import { Context, Next } from 'hono';

export interface PaywallConfig {
  costUsdc: number; // e.g. 0.02 ($0.02)
  costSats: number; // e.g. 20 sats
  baseRecipientAddress: string;
  enableSandbox: boolean; // allows 'TEST_PREIMAGE' or '?demo=true' for local testing
  maxDemoQueries?: number; // default: 3 free queries before requiring 402 payment
}

export const DEFAULT_CONFIG: PaywallConfig = {
  costUsdc: 0.02,
  costSats: 20,
  baseRecipientAddress: '0x8a8c238ed2b46908Ff6C6922a3870984f20f8913', // replace with creator's wallet
  enableSandbox: true,
  maxDemoQueries: 3,
};

// In-memory nonce store (for Cloudflare Workers, can be backed by Upstash or KV)
const spentTokens = new Set<string>();

// Track free demo trial queries per client identifier (IP or test session)
const demoUsageMap = new Map<string, number>();

export function paywall402(config: Partial<PaywallConfig> = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const maxDemo = cfg.maxDemoQueries ?? 3;

  return async function (c: Context, next: Next) {
    // Determine client identifier for demo quota tracking
    const clientIp =
      c.req.header('cf-connecting-ip') ||
      c.req.header('x-real-ip') ||
      c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
      'sandbox_tester';

    // 1. Check for free bypass / demo testing (limited to maxDemo queries)
    const isDemo = c.req.query('demo') === 'true';
    if (cfg.enableSandbox && isDemo) {
      const currentUsage = demoUsageMap.get(clientIp) || 0;

      if (currentUsage < maxDemo) {
        demoUsageMap.set(clientIp, currentUsage + 1);
        const remaining = maxDemo - (currentUsage + 1);
        
        c.header('X-Demo-Trial', 'active');
        c.header('X-Demo-Used', (currentUsage + 1).toString());
        c.header('X-Demo-Remaining', remaining.toString());
        c.set('paymentType', `demo_sandbox_trial_${currentUsage + 1}_of_${maxDemo}`);
        
        return await next();
      }

      // If demo limit reached, proceed to 402 challenge below with an explicit note
    }

    const authHeader = c.req.header('Authorization');

    // 2. Validate Payment if Authorization header is present
    if (authHeader) {
      // Check L402 format: "L402 <macaroon>:<preimage>"
      if (authHeader.startsWith('L402 ')) {
        const credentials = authHeader.slice(5).trim();
        const [token, preimage] = credentials.split(':');

        if (token && preimage) {
          // Sandbox or valid preimage verification
          if (cfg.enableSandbox && (preimage.startsWith('TEST_') || preimage.length === 64)) {
            if (spentTokens.has(token)) {
              return c.json({ error: 'Token already redeemed (replay attack prevented)' }, 402);
            }
            spentTokens.add(token);
            c.set('paymentType', 'L402_Lightning');
            return await next();
          }
        }
      }

      // Check x402 EVM/Base format: "x402 <tx_hash_or_voucher>"
      if (authHeader.startsWith('x402 ')) {
        const proof = authHeader.slice(5).trim();
        if (proof && proof.length >= 10) {
          if (spentTokens.has(proof)) {
            return c.json({ error: 'Payment proof already spent' }, 402);
          }
          spentTokens.add(proof);
          c.set('paymentType', 'x402_Base_USDC');
          return await next();
        }
      }

      // Check Bearer token (for traditional agent API keys or test keys)
      if (authHeader.startsWith('Bearer ')) {
        const apiKey = authHeader.slice(7).trim();
        if (apiKey.startsWith('agent_') || (cfg.enableSandbox && apiKey === 'test_key')) {
          c.set('paymentType', 'ApiKey');
          return await next();
        }
      }
    }

    // 3. No valid payment presented -> Issue HTTP 402 challenge
    const requestId = `alpha402_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const mockInvoice = `lnbc${cfg.costSats}0n1p3xxxx...${requestId.slice(-6)}`;

    c.header('WWW-Authenticate', `L402 token="${requestId}", invoice="${mockInvoice}"`);
    c.header('X-402-Cost-USDC', cfg.costUsdc.toString());
    c.header('X-402-Cost-Sats', cfg.costSats.toString());
    c.header('X-402-Payment-Recipient', cfg.baseRecipientAddress);

    const currentUsage = demoUsageMap.get(clientIp) || 0;
    const isQuotaExceeded = isDemo && currentUsage >= maxDemo;

    return c.json(
      {
        error: isQuotaExceeded ? 'Free Demo Limit Reached' : 'Payment Required',
        statusCode: 402,
        message: isQuotaExceeded
          ? `You have used all ${maxDemo} free trial queries for your client. Please authenticate with your AI Agent wallet via L402 or x402 to continue.`
          : 'This API requires micro-payment from your AI Agent wallet.',
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
              demoLimit: maxDemo,
              demoUsed: currentUsage,
              demoRemaining: Math.max(0, maxDemo - currentUsage),
              instructions:
                currentUsage < maxDemo
                  ? `Add '?demo=true' to your request for ${maxDemo - currentUsage} more free trial queries.`
                  : 'Free demo trial exhausted. Fund your agent wallet with Base USDC or Lightning sats.',
            }
          : undefined,
      },
      402
    );
  };
}
