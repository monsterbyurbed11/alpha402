import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import {
  paywall402,
  releaseNonce,
  inspectPrepaidCreditBalance,
  DEFAULT_CONFIG,
} from './middleware/paywall402.js';
import { fetchDexData } from './services/dexscreener.js';
import { fetchSecurityReport } from './services/goplus.js';
import { fetchPolymarketAlpha } from './services/polymarket.js';
import { fetchNewPairsAlpha } from './services/newPairs.js';
import { computeAlphaSignal } from './services/alphaEngine.js';
import { recordAnalyticsEvent, getAnalyticsSnapshot } from './services/analytics.js';
import {
  Network,
  AppBindings,
  AppVariables,
  SUPPORTED_NETWORKS,
  isValidNetwork,
  isValidTokenAddress,
} from './types.js';

const app = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

// Enable CORS for web-based agent frontends & MCP web bridges
app.use('*', cors());

function getCreditTelemetry(c: any) {
  const creditsRemainingUsdc = c.get('creditsRemainingUsdc');
  const callsRemaining = c.get('callsRemaining');
  if (typeof creditsRemainingUsdc === 'number') {
    return {
      creditsRemainingUsdc,
      callsRemaining: typeof callsRemaining === 'number' ? callsRemaining : 0,
    };
  }
  const freeTrialRemaining = c.get('freeTrialRemaining');
  if (typeof freeTrialRemaining === 'number') {
    return {
      freeTrialCallsRemainingToday: freeTrialRemaining,
      upgradeToUnlimited: {
        message: `You have ${freeTrialRemaining} free daily trial call(s) remaining today. Deposit $1.00 USDC once on Base for 200 security audits or 50 full alpha calls with zero RPC latency.`,
        network: 'base',
        usdcContract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        recipientAddress: DEFAULT_CONFIG.baseRecipientAddress,
        howToUse: 'Pass your Base USDC transfer tx hash as paymentProof: "0x<your_tx_hash>" or set ALPHA402_TX_HASH in your MCP config.',
      },
    };
  }
  return {};
}

// 1. Root & Health Check (Free)
app.get('/', async (c) => {
  await recordAnalyticsEvent({ endpoint: '/', outcome: 'DISCOVERY' }, c.env?.ALPHA402_KV);
  return c.json({
    name: 'Alpha402 - DexScreener, GoPlus Token Security & Polymarket Alpha API + MCP',
    version: '1.6.0',
    description:
      'Real-time DEX token momentum, GoPlus anti-honeypot contract security audits, newly active safe pool discovery, and Polymarket arbitrage signals for AI agents. Includes 3 free daily MCP queries + instant prepaid Base USDC sessions & Coinbase x402.',
    paymentProtocol: 'HTTP 402 (3 Free Daily MCP Queries + Coinbase x402 + Base USDC Prepaid & Single-Call + L402 Lightning)',
    endpoints: {
      mcp: '/mcp',
      analytics: '/v1/analytics',
      credits: '/v1/credits?txHash=0x...',
      tokenSecurity: '/v1/token-security?network=base&address=0x...',
      tokenAlpha: '/v1/token-alpha?network=base&address=0x...',
      newPairs: '/v1/new-pairs?network=base&limit=5',
      newPairsStream: '/v1/new-pairs/stream?network=base',
      polymarketAlpha: '/v1/polymarket-alpha',
      manifest: '/.well-known/agent.json',
      openapi: '/openapi.json',
    },
    freeTrialAndPrepaid: {
      freeTrial: '3 free queries per day automatically enabled on MCP tools and via ?demo=true.',
      prepaidBaseUsdc:
        'Send any amount >= $0.005 USDC on Base to 0x8a8c238ed2b46908Ff6C6922a3870984f20f8913 (e.g. $1.00 = 50 alpha calls or 200 security audits) and reuse the same Authorization: x402 <tx_hash>.',
    },
    scoringFormula: {
      formula: 'AlphaScore = (Security * 0.40) + (Momentum * 0.35) + (Liquidity * 0.25)',
      failSafe:
        'Fail-closed: If audit fails/times out, returns 503, data is withheld, and prepaid credit / nonce is refunded (reusable credit).',
      washTradingFilter:
        'Momentum is zeroed (0 pts) if wash trading is flagged; pools < 24h old get momentum discounted by poolAgeHours/24.',
      ownerPermissions: 'ownerCanChangeBalance === true hard-zeros alphaScore to 0.',
    },
    status: 'online',
  });
});

// 1.5. Real-Time Funnel & Revenue Analytics Endpoint (Free)
app.get('/v1/analytics', async (c) => {
  const snapshot = await getAnalyticsSnapshot(c.env?.ALPHA402_KV);
  return c.json({
    service: 'Alpha402 Analytics & Conversion Funnel',
    recipientWalletBaseUsdc: DEFAULT_CONFIG.baseRecipientAddress,
    ...snapshot,
  });
});

// 1.6. Free Credit Balance & Deposit Inspector (Free)
app.get('/v1/credits', async (c) => {
  const txHash = c.req.query('txHash') || c.req.header('X-Payment-Proof') || '';
  const recipient = c.env?.BASE_RECIPIENT_ADDRESS || DEFAULT_CONFIG.baseRecipientAddress;

  if (!txHash) {
    return c.json({
      freeTrialPolicy: '3 free MCP tool calls per day included automatically (or pass ?demo=true on REST endpoints).',
      depositInstructions: {
        network: 'base (Chain ID 8453)',
        token: 'USDC (0x833589fcd6edb6e08f4c7c32d4f71b54bda02913)',
        recipientWallet: recipient,
        tiers: {
          '$0.005 USDC': '1 check_token_security call',
          '$0.01 USDC': '1 get_polymarket_alpha call',
          '$0.02 USDC': '1 get_token_alpha or get_new_pairs_alpha call',
          '$1.00 USDC (Recommended)': '200 security audits OR 50 full token/new-pair alpha calls on a single tx_hash',
          '$5.00 USDC (Pro Bot)': '1,000 security audits OR 250 full token/new-pair alpha calls on a single tx_hash',
        },
        howToRedeem: 'Pass paymentProof: "0x<your_base_tx_hash>" in any MCP tool call or set ALPHA402_TX_HASH in your MCP env config.',
      },
    });
  }

  const status = await inspectPrepaidCreditBalance(txHash, c);
  return c.json({
    txHash,
    recipientWallet: recipient,
    ...status,
  });
});

// 2. Machine-Readable Agent Discovery Manifest (Free)
app.get('/.well-known/agent.json', async (c) => {
  await recordAnalyticsEvent(
    { endpoint: '/.well-known/agent.json', outcome: 'DISCOVERY' },
    c.env?.ALPHA402_KV
  );
  return c.json({
    schema_version: 'v1',
    name_for_model: 'alpha402_onchain_intelligence',
    name_for_human: 'Alpha402 On-Chain Alpha & Honeypot Security Auditor',
    description_for_model:
      'Provides fail-closed token momentum, liquidity depth, GoPlus anti-honeypot contract security audits, newly active safe token pair feeds, and Polymarket spreads for autonomous trading agents. Includes 3 free daily calls + Coinbase x402 (X-PAYMENT), multi-call prepaid Base USDC credits (Authorization: x402 <tx_hash>), and L402.',
    auth: {
      type: 'http_402',
      free_trial_daily_calls: 3,
      protocols: ['coinbase-x402', 'x402-prepaid', 'L402'],
    },
    tools: [
      {
        name: 'checkTokenSecurity',
        description: 'Fast fail-closed anti-honeypot and contract security audit ($0.005 USDC / 5 sats, first 3 calls/day free).',
        parameters: {
          type: 'object',
          properties: {
            network: { type: 'string', enum: [...SUPPORTED_NETWORKS], default: 'base' },
            address: { type: 'string', description: 'Token contract address' },
          },
          required: ['address'],
        },
      },
      {
        name: 'getTokenAlpha',
        description:
          'Analyzes contract security (fails closed on audit errors with reusable credit), volume spikes, and liquidity for any token ($0.02 USDC / 20 sats, first 3 calls/day free).',
        parameters: {
          type: 'object',
          properties: {
            network: { type: 'string', enum: [...SUPPORTED_NETWORKS], default: 'base' },
            address: { type: 'string', description: 'Token contract address' },
          },
          required: ['address'],
        },
      },
      {
        name: 'getNewPairsAlpha',
        description:
          'Scans newly active and trending token pools on a chain, filters out honeypots via GoPlus, and returns top safe pairs ranked by AlphaScore ($0.02 USDC / 20 sats, first 3 calls/day free).',
        parameters: {
          type: 'object',
          properties: {
            network: { type: 'string', enum: [...SUPPORTED_NETWORKS], default: 'base' },
            limit: { type: 'number', default: 5 },
          },
        },
      },
      {
        name: 'getPolymarketAlpha',
        description: 'Retrieves top volume prediction markets, outcomes, prices, and spreads on Polymarket ($0.01 USDC / 10 sats, first 3 calls/day free).',
        parameters: { type: 'object', properties: {} },
      },
    ],
  });
});

// 3. HTTP MCP Endpoint for Glama, Smithery, Cursor & Claude (TDQS-Optimized Tool Definitions)
export const MCP_TOOLS = [
  {
    name: 'check_token_security',
    title: 'Check Token Smart Contract Security & Honeypot Status',
    description:
      'Performs a fast, fail-closed smart contract security and anti-honeypot audit via GoPlus on Base, Solana, Ethereum, BSC, Arbitrum, or Polygon. Detects honeypots, buy/sell taxes (in % and basis points), balance modification backdoors, mint authority, and blacklists. Includes 3 free calls/day; unlimited calls cost $0.005 USDC via Base prepaid session.',
    annotations: {
      title: 'Check Token Security & Honeypot Audit',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        network: {
          type: 'string',
          enum: [...SUPPORTED_NETWORKS],
          default: 'base',
          description:
            'Target blockchain network to audit: "base", "solana", "ethereum", "bsc", "arbitrum", or "polygon". Defaults to "base".',
        },
        address: {
          type: 'string',
          description:
            'The token smart contract address (0x... for EVM chains like Base/Ethereum, or Base58 mint address for Solana). Example Base BRETT address: "0x532f27101965dd16442e59d40670faf5ebb142e4".',
        },
        paymentProof: {
          type: 'string',
          description:
            'Optional Base USDC transaction hash ("0x...") or HTTP 402 payment header for unlimited calls after your 3 free daily queries. Deposit $1.00 USDC once on Base to 0x8a8c238ed2b46908Ff6C6922a3870984f20f8913 for 200 instant security audits.',
        },
      },
      required: ['address'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_token_alpha',
    title: 'Get Token Composite AlphaScore, Momentum & Security Analysis',
    description:
      'Computes a fail-closed composite AlphaScore (0-100) combining GoPlus smart contract security (40% weight), DexScreener 5m/1h volume momentum & buy-pressure ratio (35% weight), and USD liquidity depth (25% weight) with automatic wash-trading detection. Includes 3 free calls/day; unlimited calls cost $0.02 USDC.',
    annotations: {
      title: 'Get Token Composite AlphaScore & Market Signals',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        network: {
          type: 'string',
          enum: [...SUPPORTED_NETWORKS],
          default: 'base',
          description:
            'Target blockchain network: "base", "solana", "ethereum", "bsc", "arbitrum", or "polygon". Defaults to "base".',
        },
        address: {
          type: 'string',
          description:
            'The token smart contract address (0x... for EVM chains or Base58 mint address for Solana). Example Base token: "0x532f27101965dd16442e59d40670faf5ebb142e4".',
        },
        paymentProof: {
          type: 'string',
          description:
            'Optional Base USDC transaction hash ("0x...") or HTTP 402 payment proof for unlimited calls after your 3 free daily queries. Deposit $1.00 USDC once on Base to 0x8a8c238ed2b46908Ff6C6922a3870984f20f8913 for 50 instant alpha calls.',
        },
      },
      required: ['address'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_new_pairs_alpha',
    title: 'Discover Verified Safe New & Trending DEX Token Pairs',
    description:
      'Scans newly active and boosted liquidity pools on Base, Solana, Ethereum, BSC, Arbitrum, or Polygon via DexScreener, automatically filters out honeypots and high-tax scams via GoPlus security audits, and returns the top verified safe pairs ranked by AlphaScore. Includes 3 free calls/day; unlimited calls cost $0.02 USDC.',
    annotations: {
      title: 'Discover Safe New DEX Token Pairs',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        network: {
          type: 'string',
          enum: [...SUPPORTED_NETWORKS],
          default: 'base',
          description:
            'Blockchain network to scan for safe new token pools ("base", "solana", "ethereum", "bsc", "arbitrum", or "polygon"). Defaults to "base".',
        },
        limit: {
          type: 'number',
          default: 5,
          minimum: 1,
          maximum: 10,
          description: 'Maximum number of verified safe token pairs to return (between 1 and 10, defaults to 5).',
        },
        paymentProof: {
          type: 'string',
          description:
            'Optional Base USDC transaction hash ("0x...") or HTTP 402 payment proof for unlimited calls after your 3 free daily queries.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_polymarket_alpha',
    title: 'Get Polymarket High-Volume Prediction Markets & Arbitrage Spreads',
    description:
      'Retrieves the highest-volume active prediction markets on Polymarket along with outcome probabilities, liquidity depth in USD, and binary arbitrage spreads. Includes 3 free calls/day; unlimited calls cost $0.01 USDC.',
    annotations: {
      title: 'Get Polymarket Prediction Market Alpha & Spreads',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        paymentProof: {
          type: 'string',
          description:
            'Optional Base USDC transaction hash ("0x...") or HTTP 402 payment proof for unlimited calls after your 3 free daily queries.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_credits_and_payment_info',
    title: 'Check Prepaid USDC Credit Balance & Deposit Instructions (Free)',
    description:
      '100% free utility tool with zero cost. Checks the remaining prepaid USDC credit balance and remaining call count for any Base USDC transaction hash (0x...), or returns the Base USDC deposit address and pricing tiers for upgrading from the 3 free daily calls.',
    annotations: {
      title: 'Check Credit Balance & Payment Info (Free)',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        txHash: {
          type: 'string',
          description:
            'Optional 66-character Base USDC transaction hash ("0x...") to verify on-chain and check remaining prepaid credit balance.',
        },
      },
      additionalProperties: false,
    },
  },
];

app.get('/mcp', async (c) => {
  await recordAnalyticsEvent({ endpoint: '/mcp', outcome: 'DISCOVERY' }, c.env?.ALPHA402_KV);
  return c.json({
    status: 'ready',
    service: 'alpha402-mcp-server',
    version: '1.6.0',
    capabilities: { tools: true },
    tools: MCP_TOOLS,
  });
});

app.post('/mcp', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch (err: any) {
    return c.json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: `Parse error: ${err?.message || 'Invalid JSON'}` },
    });
  }

  const { id, method, params } = body || {};

  if (method === 'initialize') {
    await recordAnalyticsEvent(
      { endpoint: '/mcp', tool: 'mcp:initialize', outcome: 'DISCOVERY' },
      c.env?.ALPHA402_KV
    );
    return c.json({
      jsonrpc: '2.0',
      id: id ?? null,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'alpha402-intelligence-mcp',
          version: '1.6.0',
        },
      },
    });
  }

  if (method === 'notifications/initialized') {
    return c.body(null, 204);
  }

  if (method === 'ping') {
    return c.json({
      jsonrpc: '2.0',
      id: id ?? null,
      result: {},
    });
  }

  if (method === 'tools/list') {
    await recordAnalyticsEvent(
      { endpoint: '/mcp', tool: 'mcp:tools/list', outcome: 'DISCOVERY' },
      c.env?.ALPHA402_KV
    );
    return c.json({
      jsonrpc: '2.0',
      id: id ?? null,
      result: { tools: MCP_TOOLS },
    });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};

    if (
      ![
        'check_token_security',
        'get_token_alpha',
        'get_new_pairs_alpha',
        'get_polymarket_alpha',
        'get_credits_and_payment_info',
      ].includes(toolName)
    ) {
      return c.json({
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code: -32601, message: `Tool not found: ${String(toolName)}` },
      });
    }

    if (toolName === 'get_credits_and_payment_info') {
      const txHash = typeof args.txHash === 'string' ? args.txHash.trim() : '';
      const creditsUrl = txHash
        ? `/v1/credits?txHash=${encodeURIComponent(txHash)}`
        : '/v1/credits';
      const subRes = await app.request(creditsUrl, { method: 'GET' }, c.env);
      const subData = await subRes.json();
      await recordAnalyticsEvent(
        {
          endpoint: '/mcp',
          tool: 'get_credits_and_payment_info',
          outcome: 'FREE_TRIAL',
        },
        c.env?.ALPHA402_KV
      );
      return c.json({
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(subData, null, 2),
            },
          ],
        },
      });
    }

    // Validate tool arguments BEFORE charging payment proof or consuming free trial
    if (toolName === 'check_token_security' || toolName === 'get_token_alpha') {
      const rawNetwork = String(args.network || 'base').toLowerCase();
      const address = typeof args.address === 'string' ? args.address.trim() : '';

      if (!isValidNetwork(rawNetwork)) {
        return c.json({
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Unsupported network "${rawNetwork}". Supported networks: ${SUPPORTED_NETWORKS.join(', ')}`,
                }),
              },
            ],
            isError: true,
          },
        });
      }

      if (!isValidTokenAddress(rawNetwork, address)) {
        return c.json({
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Invalid token contract address "${address}" for network "${rawNetwork}".`,
                }),
              },
            ],
            isError: true,
          },
        });
      }
    }

    if (toolName === 'get_new_pairs_alpha') {
      const rawNetwork = String(args.network || 'base').toLowerCase();
      if (!isValidNetwork(rawNetwork)) {
        return c.json({
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Unsupported network "${rawNetwork}". Supported networks: ${SUPPORTED_NETWORKS.join(', ')}`,
                }),
              },
            ],
            isError: true,
          },
        });
      }
    }

    // Build internal subrequest headers forwarding paymentProof and MCP free-trial eligibility
    const subHeaders: Record<string, string> = {
      Accept: 'application/json',
      'X-MCP-Trial': 'true',
    };
    const clientIp = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For');
    if (clientIp) subHeaders['X-Forwarded-For'] = clientIp;

    const existingAuth = c.req.header('Authorization');
    const existingXPayment = c.req.header('X-PAYMENT') || c.req.header('x-payment');
    if (existingAuth) subHeaders['Authorization'] = existingAuth;
    if (existingXPayment) subHeaders['X-PAYMENT'] = existingXPayment;

    const argProof = typeof args.paymentProof === 'string' ? args.paymentProof.trim() : '';
    if (argProof) {
      if (argProof.startsWith('x402 ') || argProof.startsWith('L402 ')) {
        subHeaders['Authorization'] = argProof;
      } else if (/^0x[a-fA-F0-9]{64}$/.test(argProof) || /^TEST_TX_/.test(argProof)) {
        subHeaders['Authorization'] = `x402 ${argProof}`;
      } else {
        subHeaders['X-PAYMENT'] = argProof;
      }
    }

    let internalPath = '/v1/polymarket-alpha';
    if (toolName === 'check_token_security') {
      const rawNetwork = String(args.network || 'base').toLowerCase();
      const address = String(args.address).trim();
      internalPath = `/v1/token-security?network=${encodeURIComponent(rawNetwork)}&address=${encodeURIComponent(address)}`;
    } else if (toolName === 'get_token_alpha') {
      const rawNetwork = String(args.network || 'base').toLowerCase();
      const address = String(args.address).trim();
      internalPath = `/v1/token-alpha?network=${encodeURIComponent(rawNetwork)}&address=${encodeURIComponent(address)}`;
    } else if (toolName === 'get_new_pairs_alpha') {
      const rawNetwork = String(args.network || 'base').toLowerCase();
      const limit = Number(args.limit) || 5;
      internalPath = `/v1/new-pairs?network=${encodeURIComponent(rawNetwork)}&limit=${encodeURIComponent(String(limit))}`;
    }

    const subRes = await app.request(internalPath, { method: 'GET', headers: subHeaders }, c.env);
    const subData = await subRes.json();

    return c.json({
      jsonrpc: '2.0',
      id: id ?? null,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify(subData, null, 2),
          },
        ],
        ...(subRes.status >= 500 ? { isError: true } : {}),
      },
    });
  }

  return c.json({
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code: -32601, message: `Method not found: ${String(method)}` },
  });
});

// 4. OpenAPI 3.1 Specification with Complete Response Schemas (Free)
app.get('/openapi.json', (c) => {
  return c.json({
    openapi: '3.1.0',
    info: {
      title: 'Alpha402 Intelligence API',
      version: '1.5.0',
      description:
        'HTTP 402 micro-payment on-chain alpha and security engine. Supports Official Coinbase x402 (X-PAYMENT), Multi-Call Prepaid Base USDC Sessions (Authorization: x402 <tx_hash>), and L402 Lightning.',
    },
    paths: {
      '/v1/token-security': {
        get: {
          summary: 'Fast Fail-Closed Smart Contract Security Audit ($0.005 USDC / 5 sats)',
          parameters: [
            {
              name: 'address',
              in: 'query',
              required: true,
              schema: { type: 'string', example: '0x532f27101965dd16442e59d40670faf5ebb142e4' },
            },
            {
              name: 'network',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: [...SUPPORTED_NETWORKS], default: 'base' },
            },
          ],
          responses: {
            '200': { description: 'Verified contract security audit' },
            '402': { description: 'Payment required via Coinbase x402, Prepaid Base USDC, or L402' },
            '503': { description: 'Audit unavailable - credit automatically refunded' },
          },
        },
      },
      '/v1/token-alpha': {
        get: {
          summary: 'Get Token Alpha & Security Audit ($0.02 USDC / 20 sats)',
          description:
            'Fetches live price, liquidity depth, 5m/1h volume momentum, and contract safety audit. Fails closed with 503 if audit is unavailable (reusableCredit: true, data withheld).',
          parameters: [
            {
              name: 'address',
              in: 'query',
              required: true,
              description: 'Token smart contract address',
              schema: { type: 'string', example: '0x532f27101965dd16442e59d40670faf5ebb142e4' },
            },
            {
              name: 'network',
              in: 'query',
              required: false,
              description: 'Blockchain network',
              schema: { type: 'string', enum: [...SUPPORTED_NETWORKS], default: 'base' },
            },
          ],
          responses: {
            '200': {
              description: 'Successful Alpha Signal computation',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/TokenAlphaResponse',
                  },
                },
              },
            },
            '402': {
              description: 'Payment required via L402 Lightning or x402 Base USDC',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/PaymentRequiredResponse',
                  },
                },
              },
            },
            '503': {
              description: 'Audit service unavailable - payment proof released as reusable credit',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/AuditUnavailableResponse',
                  },
                },
              },
            },
          },
        },
      },
      '/v1/new-pairs': {
        get: {
          summary: 'Get Newly Active Verified Safe Token Pairs Ranked by AlphaScore ($0.02 USDC / 20 sats)',
          parameters: [
            {
              name: 'network',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: [...SUPPORTED_NETWORKS], default: 'base' },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
            },
          ],
          responses: {
            '200': { description: 'Top verified safe new pairs ranked by AlphaScore' },
            '402': { description: 'Payment required' },
            '503': { description: 'Upstream discovery or audit unavailable - credit refunded' },
          },
        },
      },
      '/v1/new-pairs/stream': {
        get: {
          summary: 'SSE Real-Time Stream of Verified Safe New Token Pairs ($0.02 USDC / 20 sats)',
          responses: {
            '200': { description: 'Server-Sent Events (text/event-stream) alpha feed' },
            '402': { description: 'Payment required' },
          },
        },
      },
      '/v1/polymarket-alpha': {
        get: {
          summary: 'Get Polymarket High-Volume Opportunities ($0.01 USDC / 10 sats)',
          responses: {
            '200': {
              description: 'Active prediction markets and binary spreads',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/PolymarketResponse',
                  },
                },
              },
            },
            '402': {
              description: 'Payment required via L402 or x402',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/PaymentRequiredResponse',
                  },
                },
              },
            },
            '503': {
              description: 'Polymarket upstream unavailable - payment proof released as reusable credit',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/AuditUnavailableResponse',
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        TokenAlphaResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            charged: { type: 'boolean', description: 'True when service successfully fulfilled the audit' },
            reusableCredit: { type: 'boolean', description: 'False when charged' },
            paymentVerifiedBy: { type: 'string', example: 'x402_Base_USDC_Prepaid_Session_Instant' },
            creditsRemainingUsdc: { type: 'number', example: 0.98 },
            callsRemaining: { type: 'number', example: 49 },
            data: {
              type: 'object',
              properties: {
                token: {
                  type: 'object',
                  properties: {
                    symbol: { type: 'string' },
                    name: { type: 'string' },
                    address: { type: 'string' },
                    network: { type: 'string' },
                  },
                },
                alphaScore: {
                  type: ['number', 'null'],
                  minimum: 0,
                  maximum: 100,
                  description: 'Composite alpha score. 0 if honeypot or balance modification risk.',
                },
                riskLevel: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN'] },
                signals: {
                  type: 'object',
                  properties: {
                    momentumScore: { type: 'number' },
                    securityScore: { type: ['number', 'null'] },
                    liquidityScore: { type: 'number' },
                    buyPressureRatio1h: { type: 'number' },
                    volumeSpike5mVs1hAvg: { type: 'number' },
                    poolAgeHours: { type: ['number', 'null'] },
                    poolAgeDiscountApplied: { type: 'number' },
                    possibleWashTrading: { type: 'boolean' },
                  },
                },
                marketSummary: {
                  type: 'object',
                  properties: {
                    priceUsd: { type: 'number' },
                    priceChange1h: { type: 'number' },
                    priceChange24h: { type: 'number' },
                    liquidityUsd: { type: 'number' },
                    fdv: { type: 'number' },
                    volume24h: { type: 'number' },
                  },
                },
                securityAudit: {
                  type: 'object',
                  properties: {
                    auditStatus: { type: 'string', enum: ['VERIFIED', 'UNAVAILABLE', 'TIMEOUT', 'ERROR'] },
                    isHoneypot: { type: ['boolean', 'null'] },
                    buyTax: { type: 'number' },
                    sellTax: { type: 'number' },
                    buyTaxBps: { type: 'number' },
                    sellTaxBps: { type: 'number' },
                    isOpenSource: { type: 'boolean' },
                    warnings: { type: 'array', items: { type: 'string' } },
                  },
                },
                scoringMethodology: {
                  type: 'object',
                  properties: {
                    weights: {
                      type: 'object',
                      properties: {
                        security: { type: 'number', example: 0.4 },
                        momentum: { type: 'number', example: 0.35 },
                        liquidity: { type: 'number', example: 0.25 },
                      },
                    },
                    vetoConditions: { type: 'array', items: { type: 'string' } },
                  },
                },
                agentActionableSummary: { type: 'string' },
                timestamp: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
        AuditUnavailableResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string', example: 'Security audit unavailable or timed out. Failing closed.' },
            auditStatus: { type: 'string', example: 'UNAVAILABLE' },
            reusableCredit: { type: 'boolean', example: true },
            charged: { type: 'boolean', example: false },
            message: { type: 'string' },
            data: { type: 'null' },
          },
        },
        PaymentRequiredResponse: {
          type: 'object',
          properties: {
            x402Version: { type: 'number', example: 1 },
            accepts: { type: 'array', items: { type: 'object' } },
            error: { type: 'string', example: 'Payment Required' },
            statusCode: { type: 'number', example: 402 },
            pricing: {
              type: 'object',
              properties: {
                costUsdc: { type: 'number', example: 0.02 },
                costSats: { type: 'number', example: 20 },
              },
            },
            paymentOptions: { type: 'object' },
          },
        },
        PolymarketResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            charged: { type: 'boolean' },
            reusableCredit: { type: 'boolean' },
            count: { type: 'number' },
            opportunities: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  question: { type: 'string' },
                  category: { type: 'string' },
                  volumeUsd: { type: 'number' },
                  liquidityUsd: { type: 'number' },
                  spread: { type: 'number' },
                  resolutionDate: { type: 'string' },
                  url: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  });
});

// 5. Fast Micro-Tier Token Security Audit ($0.005 USDC / 5 sats)
app.get('/v1/token-security', paywall402({ costUsdc: 0.005, costSats: 5 }), async (c) => {
  const paymentType = c.get('paymentType');
  const isFreeOrDemo = paymentType === 'demo_sandbox' || paymentType === 'free_trial_3_daily';
  const rawAddress = c.req.query('address');
  const rawNetwork = (c.req.query('network') || 'base').toLowerCase();

  if (!rawAddress || !isValidNetwork(rawNetwork) || !isValidTokenAddress(rawNetwork, rawAddress.trim())) {
    const released = await releaseNonce(c);
    return c.json(
      {
        success: false,
        error: 'Invalid or missing token address or network parameter.',
        reusableCredit: isFreeOrDemo ? true : released,
        charged: isFreeOrDemo ? false : !released,
        ...getCreditTelemetry(c),
      },
      400
    );
  }

  const address = rawAddress.trim();
  const network: Network = rawNetwork;
  const securityReport = await fetchSecurityReport(network, address);
  c.header('X-Alpha402-Audit-Status', securityReport.auditStatus);

  if (securityReport.auditStatus !== 'VERIFIED') {
    const released = await releaseNonce(c);
    await recordAnalyticsEvent(
      {
        endpoint: '/v1/token-security',
        tool: 'check_token_security',
        network,
        address,
        outcome: 'REFUNDED_503',
        paymentType,
      },
      c.env?.ALPHA402_KV
    );
    return c.json(
      {
        success: false,
        error: 'Security audit unavailable or timed out. Failing closed.',
        auditStatus: securityReport.auditStatus,
        reusableCredit: isFreeOrDemo ? true : released,
        charged: isFreeOrDemo ? false : !released,
        ...getCreditTelemetry(c),
        data: null,
      },
      503
    );
  }

  await recordAnalyticsEvent(
    {
      endpoint: '/v1/token-security',
      tool: 'check_token_security',
      network,
      address,
      outcome: isFreeOrDemo ? 'FREE_TRIAL' : 'PAID_VERIFIED',
      paymentType,
      revenueUsdc: isFreeOrDemo ? 0 : 0.005,
    },
    c.env?.ALPHA402_KV
  );

  return c.json({
    success: true,
    charged: !isFreeOrDemo,
    reusableCredit: false,
    paymentVerifiedBy: paymentType,
    ...getCreditTelemetry(c),
    data: securityReport,
  });
});

// 6. Token Alpha Analysis (Protected by 402 Paywall)
app.get('/v1/token-alpha', paywall402({ costUsdc: 0.02, costSats: 20 }), async (c) => {
  const paymentType = c.get('paymentType');
  const isFreeOrDemo = paymentType === 'demo_sandbox' || paymentType === 'free_trial_3_daily';
  const rawAddress = c.req.query('address');
  const rawNetwork = (c.req.query('network') || 'base').toLowerCase();

  if (!rawAddress) {
    const released = await releaseNonce(c);
    return c.json(
      {
        success: false,
        error: 'Missing required query parameter: address',
        reusableCredit: isFreeOrDemo ? true : released,
        charged: isFreeOrDemo ? false : !released,
        ...getCreditTelemetry(c),
      },
      400
    );
  }

  if (!isValidNetwork(rawNetwork)) {
    const released = await releaseNonce(c);
    return c.json(
      {
        success: false,
        error: `Unsupported network "${rawNetwork}". Supported networks: ${SUPPORTED_NETWORKS.join(', ')}`,
        reusableCredit: isFreeOrDemo ? true : released,
        charged: isFreeOrDemo ? false : !released,
        ...getCreditTelemetry(c),
      },
      400
    );
  }

  const address = rawAddress.trim();
  const network: Network = rawNetwork;

  if (!isValidTokenAddress(network, address)) {
    const released = await releaseNonce(c);
    return c.json(
      {
        success: false,
        error: `Invalid token contract address format for network "${network}".`,
        reusableCredit: isFreeOrDemo ? true : released,
        charged: isFreeOrDemo ? false : !released,
        ...getCreditTelemetry(c),
      },
      400
    );
  }

  try {
    const [dexData, securityReport] = await Promise.all([
      fetchDexData(address, network),
      fetchSecurityReport(network, address),
    ]);

    if (!dexData) {
      const released = await releaseNonce(c);
      return c.json(
        {
          success: false,
          error: `No active liquidity pools found for address ${address} on network ${network}.`,
          reusableCredit: isFreeOrDemo ? true : released,
          charged: isFreeOrDemo ? false : !released,
          ...getCreditTelemetry(c),
          suggestion: 'Verify the token contract address. Your payment proof remains valid and reusable.',
        },
        404
      );
    }

    c.header('X-Alpha402-Audit-Status', securityReport.auditStatus);
    const isAuditVerified = securityReport.auditStatus === 'VERIFIED';

    if (!isAuditVerified) {
      const released = await releaseNonce(c);
      await recordAnalyticsEvent(
        {
          endpoint: '/v1/token-alpha',
          tool: 'get_token_alpha',
          network,
          address,
          outcome: 'REFUNDED_503',
          paymentType,
        },
        c.env?.ALPHA402_KV
      );
      return c.json(
        {
          success: false,
          error: 'Security audit unavailable or timed out. Failing closed.',
          auditStatus: securityReport.auditStatus,
          reusableCredit: isFreeOrDemo ? true : released,
          charged: isFreeOrDemo ? false : !released,
          ...getCreditTelemetry(c),
          message:
            'Upstream audit failed. Payment proof was NOT consumed and remains a reusable credit. Data withheld to prevent unverified trading.',
          data: null,
        },
        503
      );
    }

    const alphaResult = computeAlphaSignal(network, dexData, securityReport);

    await recordAnalyticsEvent(
      {
        endpoint: '/v1/token-alpha',
        tool: 'get_token_alpha',
        network,
        address,
        outcome: isFreeOrDemo ? 'FREE_TRIAL' : 'PAID_VERIFIED',
        paymentType,
        revenueUsdc: isFreeOrDemo ? 0 : 0.02,
      },
      c.env?.ALPHA402_KV
    );

    return c.json({
      success: true,
      charged: !isFreeOrDemo,
      reusableCredit: false,
      paymentVerifiedBy: paymentType,
      ...getCreditTelemetry(c),
      data: alphaResult,
    });
  } catch (err: any) {
    const released = await releaseNonce(c);
    return c.json(
      {
        success: false,
        error: 'Internal error while computing token alpha. Failing closed.',
        reusableCredit: isFreeOrDemo ? true : released,
        charged: isFreeOrDemo ? false : !released,
        ...getCreditTelemetry(c),
        data: null,
      },
      503
    );
  }
});

// 7. Newly Active Safe Pairs Discovery Feed ($0.02 USDC / 20 sats)
app.get('/v1/new-pairs', paywall402({ costUsdc: 0.02, costSats: 20 }), async (c) => {
  const paymentType = c.get('paymentType');
  const isFreeOrDemo = paymentType === 'demo_sandbox' || paymentType === 'free_trial_3_daily';
  const rawNetwork = (c.req.query('network') || 'base').toLowerCase();
  const limit = Number(c.req.query('limit') || '5');

  if (!isValidNetwork(rawNetwork)) {
    const released = await releaseNonce(c);
    return c.json(
      {
        success: false,
        error: `Unsupported network "${rawNetwork}". Supported networks: ${SUPPORTED_NETWORKS.join(', ')}`,
        reusableCredit: isFreeOrDemo ? true : released,
        charged: isFreeOrDemo ? false : !released,
        ...getCreditTelemetry(c),
      },
      400
    );
  }

  const feed = await fetchNewPairsAlpha(rawNetwork, limit);
  if (!feed || feed.pairs.length === 0) {
    const released = await releaseNonce(c);
    await recordAnalyticsEvent(
      {
        endpoint: '/v1/new-pairs',
        tool: 'get_new_pairs_alpha',
        network: rawNetwork,
        outcome: 'REFUNDED_503',
        paymentType,
      },
      c.env?.ALPHA402_KV
    );
    return c.json(
      {
        success: false,
        error: `No verified safe token pairs found on ${rawNetwork} at this time. Failing closed.`,
        reusableCredit: isFreeOrDemo ? true : released,
        charged: isFreeOrDemo ? false : !released,
        ...getCreditTelemetry(c),
        data: null,
      },
      503
    );
  }

  await recordAnalyticsEvent(
    {
      endpoint: '/v1/new-pairs',
      tool: 'get_new_pairs_alpha',
      network: rawNetwork,
      outcome: isFreeOrDemo ? 'FREE_TRIAL' : 'PAID_VERIFIED',
      paymentType,
      revenueUsdc: isFreeOrDemo ? 0 : 0.02,
    },
    c.env?.ALPHA402_KV
  );

  return c.json({
    success: true,
    charged: !isFreeOrDemo,
    reusableCredit: false,
    paymentVerifiedBy: paymentType,
    ...getCreditTelemetry(c),
    data: feed,
  });
});

// 8. Real-Time SSE Stream for Newly Active Safe Pairs ($0.02 USDC / 20 sats)
app.get('/v1/new-pairs/stream', paywall402({ costUsdc: 0.02, costSats: 20 }), async (c) => {
  const paymentType = c.get('paymentType');
  const isFreeOrDemo = paymentType === 'demo_sandbox' || paymentType === 'free_trial_3_daily';
  const rawNetwork = (c.req.query('network') || 'base').toLowerCase();
  const limit = Number(c.req.query('limit') || '5');

  if (!isValidNetwork(rawNetwork)) {
    const released = await releaseNonce(c);
    return c.json(
      {
        success: false,
        error: `Unsupported network "${rawNetwork}". Supported networks: ${SUPPORTED_NETWORKS.join(', ')}`,
        reusableCredit: isFreeOrDemo ? true : released,
        charged: isFreeOrDemo ? false : !released,
      },
      400
    );
  }

  const feed = await fetchNewPairsAlpha(rawNetwork, limit);
  if (!feed || feed.pairs.length === 0) {
    const released = await releaseNonce(c);
    return c.json(
      {
        success: false,
        error: `No verified safe token pairs available to stream on ${rawNetwork}. Failing closed.`,
        reusableCredit: isFreeOrDemo ? true : released,
        charged: isFreeOrDemo ? false : !released,
      },
      503
    );
  }

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: 'snapshot',
      id: Date.now().toString(),
      data: JSON.stringify({
        paymentVerifiedBy: paymentType,
        ...getCreditTelemetry(c),
        ...feed,
      }),
    });

    for (const pair of feed.pairs) {
      await stream.writeSSE({
        event: 'alpha_signal',
        id: `${pair.token.address}_${Date.now()}`,
        data: JSON.stringify(pair),
      });
    }
  });
});

// 9. Polymarket Alpha Signals (Protected by 402 Paywall)
app.get('/v1/polymarket-alpha', paywall402({ costUsdc: 0.01, costSats: 10 }), async (c) => {
  const paymentType = c.get('paymentType');
  const isFreeOrDemo = paymentType === 'demo_sandbox' || paymentType === 'free_trial_3_daily';
  const opportunities = await fetchPolymarketAlpha();

  if (!opportunities) {
    const released = await releaseNonce(c);
    await recordAnalyticsEvent(
      {
        endpoint: '/v1/polymarket-alpha',
        tool: 'get_polymarket_alpha',
        outcome: 'REFUNDED_503',
        paymentType,
      },
      c.env?.ALPHA402_KV
    );
    return c.json(
      {
        success: false,
        error: 'Polymarket upstream service unavailable or timed out. Failing closed.',
        reusableCredit: isFreeOrDemo ? true : released,
        charged: isFreeOrDemo ? false : !released,
        ...getCreditTelemetry(c),
        opportunities: null,
      },
      503
    );
  }

  await recordAnalyticsEvent(
    {
      endpoint: '/v1/polymarket-alpha',
      tool: 'get_polymarket_alpha',
      outcome: isFreeOrDemo ? 'FREE_TRIAL' : 'PAID_VERIFIED',
      paymentType,
      revenueUsdc: isFreeOrDemo ? 0 : 0.01,
    },
    c.env?.ALPHA402_KV
  );

  return c.json({
    success: true,
    charged: !isFreeOrDemo,
    reusableCredit: false,
    paymentVerifiedBy: paymentType,
    ...getCreditTelemetry(c),
    count: opportunities.length,
    opportunities,
    timestamp: new Date().toISOString(),
  });
});

export default app;
