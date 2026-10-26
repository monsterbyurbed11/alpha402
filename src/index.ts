import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { paywall402, releaseNonce } from './middleware/paywall402.js';
import { fetchDexData } from './services/dexscreener.js';
import { fetchSecurityReport } from './services/goplus.js';
import { fetchPolymarketAlpha } from './services/polymarket.js';
import { fetchNewPairsAlpha } from './services/newPairs.js';
import { computeAlphaSignal } from './services/alphaEngine.js';
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
  return {};
}

// 1. Root & Health Check (Free)
app.get('/', (c) => {
  return c.json({
    name: 'Alpha402 - Agent On-Chain Alpha API',
    version: '1.5.0',
    description:
      'Cryptographically and RPC-verified, fail-closed on-chain alpha engine for autonomous AI agents. Supports Coinbase x402, Instant Multi-Call Prepaid Base USDC Sessions, and L402 Lightning.',
    paymentProtocol: 'HTTP 402 (Coinbase x402 / Base USDC Prepaid & Single-Call / L402 Lightning HMAC + SHA-256)',
    endpoints: {
      mcp: '/mcp',
      tokenSecurity: '/v1/token-security?network=base&address=0x...',
      tokenAlpha: '/v1/token-alpha?network=base&address=0x...',
      newPairs: '/v1/new-pairs?network=base&limit=5',
      newPairsStream: '/v1/new-pairs/stream?network=base',
      polymarketAlpha: '/v1/polymarket-alpha',
      manifest: '/.well-known/agent.json',
      openapi: '/openapi.json',
    },
    prepaidSessions: {
      description:
        'Send any amount >= endpoint cost in a single Base USDC transfer (e.g. $1.00 = 50 alpha calls or 200 security audits) and reuse the same Authorization: x402 <tx_hash> with sub-20ms Redis deduction and zero Base RPC latency.',
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

// 2. Machine-Readable Agent Discovery Manifest (Free)
app.get('/.well-known/agent.json', (c) => {
  return c.json({
    schema_version: 'v1',
    name_for_model: 'alpha402_onchain_intelligence',
    name_for_human: 'Alpha402 On-Chain Alpha',
    description_for_model:
      'Provides fail-closed token momentum, liquidity depth, anti-honeypot contract security audits, newly active safe token pair feeds, and Polymarket spreads for autonomous trading agents. Supports Coinbase x402 (X-PAYMENT), multi-call prepaid Base USDC credits (Authorization: x402 <tx_hash>), and L402.',
    auth: {
      type: 'http_402',
      protocols: ['coinbase-x402', 'x402-prepaid', 'L402'],
    },
    tools: [
      {
        name: 'checkTokenSecurity',
        description: 'Fast fail-closed anti-honeypot and contract security audit ($0.005 USDC / 5 sats).',
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
          'Analyzes contract security (fails closed on audit errors with reusable credit), volume spikes, and liquidity for any token ($0.02 USDC / 20 sats).',
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
          'Scans newly active and trending token pools on a chain, filters out honeypots via GoPlus, and returns top safe pairs ranked by AlphaScore ($0.02 USDC / 20 sats).',
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
        description: 'Retrieves top volume prediction markets, outcomes, prices, and spreads on Polymarket ($0.01 USDC / 10 sats).',
        parameters: { type: 'object', properties: {} },
      },
    ],
  });
});

// 3. HTTP MCP Endpoint for Smithery, Cursor & Claude (Streamable & JSON-RPC)
export const MCP_TOOLS = [
  {
    name: 'check_token_security',
    description:
      'Fast fail-closed anti-honeypot and smart contract security audit (checks honeypots, high buy/sell tax, blacklist, freeze authority, balance modification). Micro-tier: $0.005 USDC / 5 sats.',
    inputSchema: {
      type: 'object',
      properties: {
        network: {
          type: 'string',
          enum: [...SUPPORTED_NETWORKS],
          description: 'Blockchain network (default is base)',
        },
        address: {
          type: 'string',
          description: 'The smart contract address or token mint address',
        },
        paymentProof: {
          type: 'string',
          description:
            'Optional HTTP 402 payment header value (e.g. "x402 0x<base_usdc_tx_hash>" or "L402 <token>:<preimage>" or base64 Coinbase X-PAYMENT). Deposit $1 USDC once for 200 instant calls.',
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'get_token_alpha',
    description:
      'Performs fail-closed real-time security audit (is_honeypot, sell taxes, balance modifications), volume momentum analysis, and liquidity depth scoring for any token. Supports Base, Solana, Ethereum, BSC, Arbitrum, Polygon ($0.02 USDC / 20 sats).',
    inputSchema: {
      type: 'object',
      properties: {
        network: {
          type: 'string',
          enum: [...SUPPORTED_NETWORKS],
          description: 'Blockchain network (default is base)',
        },
        address: {
          type: 'string',
          description: 'The smart contract address or token mint address',
        },
        paymentProof: {
          type: 'string',
          description:
            'Optional HTTP 402 payment header value (e.g. "x402 0x<base_usdc_tx_hash>" or "L402 <token>:<preimage>"). Deposit $1 USDC once for 50 instant calls.',
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'get_new_pairs_alpha',
    description:
      'Discovers newly active and trending token pools on Base, Solana, Ethereum, BSC, Arbitrum, or Polygon, filters out honeypots via GoPlus fail-closed audits, and returns the top safe pairs ranked by AlphaScore ($0.02 USDC / 20 sats).',
    inputSchema: {
      type: 'object',
      properties: {
        network: {
          type: 'string',
          enum: [...SUPPORTED_NETWORKS],
          description: 'Blockchain network (default is base)',
        },
        limit: {
          type: 'number',
          description: 'Max number of verified safe pairs to return (1-10, default 5)',
        },
        paymentProof: {
          type: 'string',
          description:
            'Optional HTTP 402 payment header value (e.g. "x402 0x<base_usdc_tx_hash>" or "L402 <token>:<preimage>").',
        },
      },
    },
  },
  {
    name: 'get_polymarket_alpha',
    description:
      'Retrieves top volume prediction markets, outcomes, prices, and arbitrage spreads from Polymarket ($0.01 USDC / 10 sats).',
    inputSchema: {
      type: 'object',
      properties: {
        paymentProof: {
          type: 'string',
          description:
            'Optional HTTP 402 payment header value (e.g. "x402 0x<base_usdc_tx_hash>" or "L402 <token>:<preimage>").',
        },
      },
    },
  },
];

app.get('/mcp', (c) => {
  return c.json({
    status: 'ready',
    service: 'alpha402-mcp-server',
    version: '1.5.0',
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
    return c.json({
      jsonrpc: '2.0',
      id: id ?? null,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'alpha402-intelligence-mcp',
          version: '1.5.0',
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
      !['check_token_security', 'get_token_alpha', 'get_new_pairs_alpha', 'get_polymarket_alpha'].includes(
        toolName
      )
    ) {
      return c.json({
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code: -32601, message: `Tool not found: ${String(toolName)}` },
      });
    }

    // Validate tool arguments BEFORE charging payment proof
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

    // Enforce HTTP 402 paywall on remote HTTP tool executions
    const tierCosts =
      toolName === 'check_token_security'
        ? { costUsdc: 0.005, costSats: 5 }
        : toolName === 'get_polymarket_alpha'
          ? { costUsdc: 0.01, costSats: 10 }
          : { costUsdc: 0.02, costSats: 20 };

    let authorized = false;
    const paywallResponse = await paywall402(tierCosts)(c, async () => {
      authorized = true;
    });

    if (!authorized && paywallResponse) {
      return paywallResponse;
    }

    const isDemo = c.get('paymentType') === 'demo_sandbox';

    if (toolName === 'check_token_security') {
      const address = String(args.address).trim();
      const network = String(args.network || 'base').toLowerCase() as Network;
      const securityReport = await fetchSecurityReport(network, address);

      if (securityReport.auditStatus !== 'VERIFIED') {
        const released = await releaseNonce(c);
        return c.json({
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: false,
                    error: 'Security audit unavailable or timed out. Failing closed.',
                    auditStatus: securityReport.auditStatus,
                    reusableCredit: isDemo ? true : released,
                    charged: isDemo ? false : !released,
                    ...getCreditTelemetry(c),
                    securityReport,
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          },
        });
      }

      return c.json({
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  charged: true,
                  paymentVerifiedBy: c.get('paymentType'),
                  ...getCreditTelemetry(c),
                  securityAudit: securityReport,
                },
                null,
                2
              ),
            },
          ],
        },
      });
    }

    if (toolName === 'get_token_alpha') {
      const address = String(args.address).trim();
      const network = String(args.network || 'base').toLowerCase() as Network;

      const [dexData, securityReport] = await Promise.all([
        fetchDexData(address, network),
        fetchSecurityReport(network, address),
      ]);

      if (!dexData) {
        const released = await releaseNonce(c);
        return c.json({
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: `No active liquidity pools found for ${address} on ${network}.`,
                  reusableCredit: isDemo ? true : released,
                  charged: isDemo ? false : !released,
                  ...getCreditTelemetry(c),
                }),
              },
            ],
            isError: true,
          },
        });
      }

      if (securityReport.auditStatus !== 'VERIFIED') {
        const released = await releaseNonce(c);
        return c.json({
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: false,
                    error: 'Security audit unavailable or timed out. Failing closed.',
                    auditStatus: securityReport.auditStatus,
                    reusableCredit: isDemo ? true : released,
                    charged: isDemo ? false : !released,
                    ...getCreditTelemetry(c),
                    data: null,
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          },
        });
      }

      const alphaSignal = computeAlphaSignal(network, dexData, securityReport);
      return c.json({
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  charged: true,
                  paymentVerifiedBy: c.get('paymentType'),
                  ...getCreditTelemetry(c),
                  data: alphaSignal,
                },
                null,
                2
              ),
            },
          ],
        },
      });
    }

    if (toolName === 'get_new_pairs_alpha') {
      const network = String(args.network || 'base').toLowerCase() as Network;
      const limit = Number(args.limit) || 5;
      const feed = await fetchNewPairsAlpha(network, limit);

      if (!feed || feed.pairs.length === 0) {
        const released = await releaseNonce(c);
        return c.json({
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: `No verified safe token pairs found on ${network} at this time. Failing closed.`,
                  reusableCredit: isDemo ? true : released,
                  charged: isDemo ? false : !released,
                  ...getCreditTelemetry(c),
                }),
              },
            ],
            isError: true,
          },
        });
      }

      return c.json({
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  charged: true,
                  paymentVerifiedBy: c.get('paymentType'),
                  ...getCreditTelemetry(c),
                  ...feed,
                },
                null,
                2
              ),
            },
          ],
        },
      });
    }

    if (toolName === 'get_polymarket_alpha') {
      const markets = await fetchPolymarketAlpha();
      if (!markets) {
        const released = await releaseNonce(c);
        return c.json({
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: 'Polymarket upstream service unavailable or timed out.',
                  reusableCredit: isDemo ? true : released,
                  charged: isDemo ? false : !released,
                  ...getCreditTelemetry(c),
                }),
              },
            ],
            isError: true,
          },
        });
      }

      return c.json({
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  charged: true,
                  paymentVerifiedBy: c.get('paymentType'),
                  ...getCreditTelemetry(c),
                  count: markets.length,
                  opportunities: markets,
                },
                null,
                2
              ),
            },
          ],
        },
      });
    }
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
  const isDemo = c.get('paymentType') === 'demo_sandbox';
  const rawAddress = c.req.query('address');
  const rawNetwork = (c.req.query('network') || 'base').toLowerCase();

  if (!rawAddress || !isValidNetwork(rawNetwork) || !isValidTokenAddress(rawNetwork, rawAddress.trim())) {
    const released = await releaseNonce(c);
    return c.json(
      {
        success: false,
        error: 'Invalid or missing token address or network parameter.',
        reusableCredit: isDemo ? true : released,
        charged: isDemo ? false : !released,
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
    return c.json(
      {
        success: false,
        error: 'Security audit unavailable or timed out. Failing closed.',
        auditStatus: securityReport.auditStatus,
        reusableCredit: isDemo ? true : released,
        charged: isDemo ? false : !released,
        ...getCreditTelemetry(c),
        data: null,
      },
      503
    );
  }

  return c.json({
    success: true,
    charged: true,
    reusableCredit: false,
    paymentVerifiedBy: c.get('paymentType'),
    ...getCreditTelemetry(c),
    data: securityReport,
  });
});

// 6. Token Alpha Analysis (Protected by 402 Paywall)
app.get('/v1/token-alpha', paywall402({ costUsdc: 0.02, costSats: 20 }), async (c) => {
  const isDemo = c.get('paymentType') === 'demo_sandbox';
  const rawAddress = c.req.query('address');
  const rawNetwork = (c.req.query('network') || 'base').toLowerCase();

  if (!rawAddress) {
    const released = await releaseNonce(c);
    return c.json(
      {
        success: false,
        error: 'Missing required query parameter: address',
        reusableCredit: isDemo ? true : released,
        charged: isDemo ? false : !released,
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
        reusableCredit: isDemo ? true : released,
        charged: isDemo ? false : !released,
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
        reusableCredit: isDemo ? true : released,
        charged: isDemo ? false : !released,
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
          reusableCredit: isDemo ? true : released,
          charged: isDemo ? false : !released,
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
      return c.json(
        {
          success: false,
          error: 'Security audit unavailable or timed out. Failing closed.',
          auditStatus: securityReport.auditStatus,
          reusableCredit: isDemo ? true : released,
          charged: isDemo ? false : !released,
          ...getCreditTelemetry(c),
          message:
            'Upstream audit failed. Payment proof was NOT consumed and remains a reusable credit. Data withheld to prevent unverified trading.',
          data: null,
        },
        503
      );
    }

    const alphaResult = computeAlphaSignal(network, dexData, securityReport);

    return c.json({
      success: true,
      charged: true,
      reusableCredit: false,
      paymentVerifiedBy: c.get('paymentType'),
      ...getCreditTelemetry(c),
      data: alphaResult,
    });
  } catch (err: any) {
    const released = await releaseNonce(c);
    return c.json(
      {
        success: false,
        error: 'Internal error while computing token alpha. Failing closed.',
        reusableCredit: isDemo ? true : released,
        charged: isDemo ? false : !released,
        ...getCreditTelemetry(c),
        data: null,
      },
      503
    );
  }
});

// 7. Newly Active Safe Pairs Discovery Feed ($0.02 USDC / 20 sats)
app.get('/v1/new-pairs', paywall402({ costUsdc: 0.02, costSats: 20 }), async (c) => {
  const isDemo = c.get('paymentType') === 'demo_sandbox';
  const rawNetwork = (c.req.query('network') || 'base').toLowerCase();
  const limit = Number(c.req.query('limit') || '5');

  if (!isValidNetwork(rawNetwork)) {
    const released = await releaseNonce(c);
    return c.json(
      {
        success: false,
        error: `Unsupported network "${rawNetwork}". Supported networks: ${SUPPORTED_NETWORKS.join(', ')}`,
        reusableCredit: isDemo ? true : released,
        charged: isDemo ? false : !released,
        ...getCreditTelemetry(c),
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
        error: `No verified safe token pairs found on ${rawNetwork} at this time. Failing closed.`,
        reusableCredit: isDemo ? true : released,
        charged: isDemo ? false : !released,
        ...getCreditTelemetry(c),
        data: null,
      },
      503
    );
  }

  return c.json({
    success: true,
    charged: true,
    reusableCredit: false,
    paymentVerifiedBy: c.get('paymentType'),
    ...getCreditTelemetry(c),
    data: feed,
  });
});

// 8. Real-Time SSE Stream for Newly Active Safe Pairs ($0.02 USDC / 20 sats)
app.get('/v1/new-pairs/stream', paywall402({ costUsdc: 0.02, costSats: 20 }), async (c) => {
  const isDemo = c.get('paymentType') === 'demo_sandbox';
  const rawNetwork = (c.req.query('network') || 'base').toLowerCase();
  const limit = Number(c.req.query('limit') || '5');

  if (!isValidNetwork(rawNetwork)) {
    const released = await releaseNonce(c);
    return c.json(
      {
        success: false,
        error: `Unsupported network "${rawNetwork}". Supported networks: ${SUPPORTED_NETWORKS.join(', ')}`,
        reusableCredit: isDemo ? true : released,
        charged: isDemo ? false : !released,
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
        reusableCredit: isDemo ? true : released,
        charged: isDemo ? false : !released,
      },
      503
    );
  }

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: 'snapshot',
      id: Date.now().toString(),
      data: JSON.stringify({
        paymentVerifiedBy: c.get('paymentType'),
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
  const isDemo = c.get('paymentType') === 'demo_sandbox';
  const opportunities = await fetchPolymarketAlpha();

  if (!opportunities) {
    const released = await releaseNonce(c);
    return c.json(
      {
        success: false,
        error: 'Polymarket upstream service unavailable or timed out. Failing closed.',
        reusableCredit: isDemo ? true : released,
        charged: isDemo ? false : !released,
        ...getCreditTelemetry(c),
        opportunities: null,
      },
      503
    );
  }

  return c.json({
    success: true,
    charged: true,
    reusableCredit: false,
    paymentVerifiedBy: c.get('paymentType'),
    ...getCreditTelemetry(c),
    count: opportunities.length,
    opportunities,
    timestamp: new Date().toISOString(),
  });
});

export default app;
