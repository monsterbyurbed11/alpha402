import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { paywall402, releaseNonce } from './middleware/paywall402.js';
import { fetchDexData } from './services/dexscreener.js';
import { fetchSecurityReport } from './services/goplus.js';
import { fetchPolymarketAlpha } from './services/polymarket.js';
import { computeAlphaSignal } from './services/alphaEngine.js';
import { Network } from './types.js';

const app = new Hono();

// Enable CORS for web-based agent frontends & MCP web bridges
app.use('*', cors());

// 1. Root & Health Check (Free)
app.get('/', (c) => {
  return c.json({
    name: 'Alpha402 - Agent On-Chain Alpha API',
    version: '1.4.0',
    description: 'Cryptographically and RPC-verified, fail-closed on-chain alpha engine for autonomous AI agents.',
    paymentProtocol: 'HTTP 402 (Base USDC on-chain verified / L402 Lightning SHA-256)',
    endpoints: {
      mcp: '/mcp',
      tokenAlpha: '/v1/token-alpha?network=base&address=0x...',
      polymarketAlpha: '/v1/polymarket-alpha',
      manifest: '/.well-known/agent.json',
      openapi: '/openapi.json',
    },
    scoringFormula: {
      formula: 'AlphaScore = (Security * 0.40) + (Momentum * 0.35) + (Liquidity * 0.25)',
      failSafe: 'Fail-closed: If audit fails/times out, returns 503, data is withheld, and nonce is DEL released (reusable credit).',
      washTradingFilter: 'Momentum is zeroed (0 pts) if wash trading is flagged; pools < 24h old get momentum discounted by poolAgeHours/24.',
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
      'Provides fail-closed token momentum, liquidity depth, anti-honeypot contract security audits (weighted 40% security, 35% momentum, 25% liquidity, pool-age dampened), and Polymarket spreads for autonomous trading agents. Returns 503 and releases payment proof as reusable credit on audit failures. Costs $0.02 USDC on Base or 20 sats via HTTP 402.',
    auth: {
      type: 'http_402',
      protocols: ['x402', 'L402'],
    },
    tools: [
      {
        name: 'getTokenAlpha',
        description: 'Analyzes contract security (fails closed on audit errors with reusable credit), volume spikes, and liquidity for any token.',
        parameters: {
          type: 'object',
          properties: {
            network: { type: 'string', enum: ['base', 'solana', 'ethereum', 'bsc', 'arbitrum', 'polygon'], default: 'base' },
            address: { type: 'string', description: 'Token contract address' },
          },
          required: ['address'],
        },
      },
      {
        name: 'getPolymarketAlpha',
        description: 'Retrieves top volume prediction markets, outcomes, prices, and spreads on Polymarket.',
        parameters: { type: 'object', properties: {} },
      },
    ],
  });
});

// 3. HTTP MCP Endpoint for Smithery, Cursor & Claude (Streamable & JSON-RPC)
const MCP_TOOLS = [
  {
    name: 'get_token_alpha',
    description:
      'Performs fail-closed real-time security audit (is_honeypot, sell taxes, balance modifications), volume momentum analysis, and liquidity depth scoring for any token. Supports Base, Solana, Ethereum, BSC, Arbitrum.',
    inputSchema: {
      type: 'object',
      properties: {
        network: {
          type: 'string',
          enum: ['base', 'solana', 'ethereum', 'bsc', 'arbitrum', 'polygon'],
          description: 'Blockchain network (default is base)',
        },
        address: {
          type: 'string',
          description: 'The smart contract address or token mint address',
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'get_polymarket_alpha',
    description: 'Retrieves top volume prediction markets, outcomes, prices, and arbitrage spreads from Polymarket.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

app.get('/mcp', (c) => {
  return c.json({
    status: 'ready',
    service: 'alpha402-mcp-server',
    version: '1.4.0',
    capabilities: { tools: true },
    tools: MCP_TOOLS,
  });
});

app.post('/mcp', async (c) => {
  try {
    const body: any = await c.req.json();
    const { id, method, params } = body;

    if (method === 'initialize') {
      return c.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'alpha402-intelligence-mcp',
            version: '1.4.0',
          },
        },
      });
    }

    if (method === 'tools/list') {
      return c.json({
        jsonrpc: '2.0',
        id,
        result: { tools: MCP_TOOLS },
      });
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const args = params?.arguments || {};

      if (toolName === 'get_token_alpha') {
        const address = args.address;
        const network = (args.network || 'base').toLowerCase() as Network;

        const [dexData, securityReport] = await Promise.all([
          fetchDexData(address, network),
          fetchSecurityReport(network, address),
        ]);

        if (!dexData) {
          return c.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `No active liquidity pools found for ${address} on ${network}.` }],
              isError: true,
            },
          });
        }

        const alphaSignal = computeAlphaSignal(network, dexData, securityReport);
        return c.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(alphaSignal, null, 2) }],
          },
        });
      }

      if (toolName === 'get_polymarket_alpha') {
        const markets = await fetchPolymarketAlpha();
        return c.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(markets, null, 2) }],
          },
        });
      }

      return c.json({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Tool not found: ${toolName}` },
      });
    }

    return c.json({
      jsonrpc: '2.0',
      id: id || null,
      result: {},
    });
  } catch (err: any) {
    return c.json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: `Parse error: ${err.message}` },
    });
  }
});

// 4. OpenAPI 3.1 Specification with Complete Response Schemas (Free)
app.get('/openapi.json', (c) => {
  return c.json({
    openapi: '3.1.0',
    info: {
      title: 'Alpha402 Intelligence API',
      version: '1.4.0',
      description:
        'HTTP 402 micro-payment on-chain alpha and security engine. Features on-chain RPC verification for Base USDC, atomic nonce rollback on audit failures (reusable credit, no free data leak), and pool-age dampened momentum.',
    },
    paths: {
      '/v1/token-alpha': {
        get: {
          summary: 'Get Token Alpha & Security Audit',
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
              schema: { type: 'string', enum: ['base', 'solana', 'ethereum', 'bsc', 'arbitrum', 'polygon'], default: 'base' },
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
      '/v1/polymarket-alpha': {
        get: {
          summary: 'Get Polymarket High-Volume Opportunities',
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
            paymentVerifiedBy: { type: 'string', example: 'x402_Base_USDC_OnChain_Verified' },
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
                        security: { type: 'number', example: 0.40 },
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
            error: { type: 'string', example: 'Payment Required' },
            statusCode: { type: 'number', example: 402 },
            pricing: {
              type: 'object',
              properties: {
                costUsdc: { type: 'number', example: 0.02 },
                costSats: { type: 'number', example: 20 },
              },
            },
            paymentOptions: {
              type: 'object',
              properties: {
                x402: {
                  type: 'object',
                  properties: {
                    protocol: { type: 'string', example: 'EVM / Base USDC' },
                    network: { type: 'string', example: 'base' },
                    amountUsdc: { type: 'number', example: 0.02 },
                    recipient: { type: 'string' },
                    settleFormat: { type: 'string', example: 'Authorization: x402 <transaction_hash>' },
                  },
                },
                l402: {
                  type: 'object',
                  properties: {
                    protocol: { type: 'string', example: 'Lightning Network' },
                    token: { type: 'string' },
                    invoice: { type: 'string' },
                    settleFormat: { type: 'string', example: 'Authorization: L402 <token>:<preimage>' },
                  },
                },
              },
            },
          },
        },
        PolymarketResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
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

// 5. Token Alpha Analysis (Protected by 402 Paywall)
app.get('/v1/token-alpha', paywall402({ costUsdc: 0.02, costSats: 20 }), async (c) => {
  const address = c.req.query('address');
  const network = (c.req.query('network') || 'base').toLowerCase() as Network;

  if (!address) {
    return c.json({ error: 'Missing required query parameter: address' }, 400);
  }

  // Query DexScreener & GoPlus concurrently (Zero added latency)
  const [dexData, securityReport] = await Promise.all([
    fetchDexData(address, network),
    fetchSecurityReport(network, address),
  ]);

  if (!dexData) {
    // Release the nonce since we couldn't fulfill the core market lookup
    await releaseNonce(c);
    return c.json(
      {
        success: false,
        error: `No active liquidity pools found for address ${address} on network ${network}.`,
        reusableCredit: true,
        charged: false,
        suggestion: 'Verify the token contract address. Your payment proof remains valid and reusable.',
      },
      404
    );
  }

  // Set audit status header so trading agents can inspect header directly
  c.header('X-Alpha402-Audit-Status', securityReport.auditStatus);

  const isAuditVerified = securityReport.auditStatus === 'VERIFIED';

  // CRITICAL FAIL-CLOSED & ANTI-EXPLOIT:
  // If audit failed, release the nonce key so proof is reusable, BUT WITHHOLD DATA!
  // No free data leak for unindexed tokens.
  if (!isAuditVerified) {
    await releaseNonce(c);
    return c.json(
      {
        success: false,
        error: 'Security audit unavailable or timed out. Failing closed.',
        auditStatus: securityReport.auditStatus,
        reusableCredit: true,
        charged: false,
        message: 'Upstream audit failed. Payment proof was NOT consumed and remains a reusable credit. Data withheld to prevent unverified trading.',
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
    data: alphaResult,
  });
});

// 6. Polymarket Alpha Signals (Protected by 402 Paywall)
app.get('/v1/polymarket-alpha', paywall402({ costUsdc: 0.01, costSats: 10 }), async (c) => {
  const opportunities = await fetchPolymarketAlpha();
  return c.json({
    success: true,
    paymentVerifiedBy: c.get('paymentType'),
    count: opportunities.length,
    opportunities,
    timestamp: new Date().toISOString(),
  });
});

export default app;
