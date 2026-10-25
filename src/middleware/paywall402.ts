import { Context, Next } from 'hono';

export interface PaywallConfig {
  costUsdc: number; // e.g. 0.02 ($0.02)
  costSats: number; // e.g. 20 sats
  baseRecipientAddress: string;
  enableSandbox: boolean; // allows 'TEST_PREIMAGE' or '?demo=true' for local testing
}

export const DEFAULT_CONFIG: PaywallConfig = {
  costUsdc: 0.02,
  costSats: 20,
  baseRecipientAddress: '0x000000000000000000000000000000000000dEaD', // replace with creator's wallet
  enableSandbox: true,
};

// In-memory nonce store (for Cloudflare Workers, can be backed by Upstash or KV)
const spentTokens = new Set<string>();

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
