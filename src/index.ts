import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { paywall402 } from './middleware/paywall402.js';
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
    version: '1.0.0',
    description: 'High-speed, anti-honeypot, on-chain alpha and prediction market signals for autonomous AI agents.',
    paymentProtocol: 'HTTP 402 (L402 / x402)',
    endpoints: {
      mcp: '/mcp',
      tokenAlpha: '/v1/token-alpha?network=base&address=0x...',
      polymarketAlpha: '/v1/polymarket-alpha',
      manifest: '/.well-known/agent.json',
      openapi: '/openapi.json',
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
      'Provides real-time token momentum, liquidity depth, anti-honeypot security audit scores, and prediction market arbitrage for trading decisions. Costs $0.02 USDC or 20 sats per request via HTTP 402.',
    auth: {
      type: 'http_402',
      protocols: ['L402', 'x402'],
    },
    tools: [
      {
        name: 'getTokenAlpha',
        description: 'Analyzes contract security (is_honeypot, taxes, balance modify), volume spikes, and liquidity for any token.',
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
      'Performs real-time security audit (is_honeypot, sell taxes, balance modifications), volume momentum analysis, and liquidity depth scoring for any token. Supports Base, Solana, Ethereum, BSC, Arbitrum.',
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
    version: '1.0.0',
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
            version: '1.0.0',
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

// 4. OpenAPI 3.1 Spec for LangChain, AutoGen & Cursor (Free)
app.get('/openapi.json', (c) => {
  return c.json({
    openapi: '3.1.0',
    info: {
      title: 'Alpha402 Intelligence API',
      version: '1.0.0',
      description: 'Micro-payment powered on-chain intelligence for autonomous agents.',
    },
    paths: {
      '/v1/token-alpha': {
        get: {
          summary: 'Get Token Alpha & Security Audit',
          parameters: [
            { name: 'address', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'network', in: 'query', required: false, schema: { type: 'string', default: 'base' } },
          ],
          responses: {
            '200': { description: 'Full token alpha analysis and LLM recommendation' },
            '402': { description: 'Payment required via L402 or x402' },
          },
        },
      },
      '/v1/polymarket-alpha': {
        get: {
          summary: 'Get Polymarket High-Volume Opportunities',
          responses: {
            '200': { description: 'Active prediction markets and spreads' },
            '402': { description: 'Payment required via L402 or x402' },
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
    return c.json(
      {
        error: `No active liquidity pools found for address ${address} on network ${network}.`,
        suggestion: 'Verify the token contract address or try another network.',
      },
      404
    );
  }

  const alphaResult = computeAlphaSignal(network, dexData, securityReport);
  return c.json({
    success: true,
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
