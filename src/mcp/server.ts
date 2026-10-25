#!/usr/bin/env node
import { fetchDexData } from '../services/dexscreener.js';
import { fetchSecurityReport } from '../services/goplus.js';
import { fetchPolymarketAlpha } from '../services/polymarket.js';
import { computeAlphaSignal } from '../services/alphaEngine.js';
import { Network } from '../types.js';
import * as readline from 'readline';

/**
 * Model Context Protocol (MCP) Server for Alpha402
 * Allows Claude Desktop, Cursor, and Autonomous Agents to consume 402-enabled alpha signals via Stdio.
 */

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

const TOOLS = [
  {
    name: 'check_token_security',
    description:
      'Fast anti-honeypot and smart contract security audit (checks honeypots, high buy/sell tax, blacklist, freeze authority, balance modification). Micro-tier: $0.005.',
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

rl.on('line', async (line) => {
  if (!line.trim()) return;

  try {
    const request = JSON.parse(line);
    const { id, method, params } = request;

    if (method === 'initialize') {
      sendResponse({
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
      return;
    }

    if (method === 'tools/list') {
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const args = params?.arguments || {};

      if (toolName === 'check_token_security') {
        const address = args.address;
        const network = (args.network || 'base').toLowerCase() as Network;

        const securityReport = await fetchSecurityReport(network, address);
        sendResponse({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(securityReport, null, 2),
              },
            ],
          },
        });
        return;
      }

      if (toolName === 'get_token_alpha') {
        const address = args.address;
        const network = (args.network || 'base').toLowerCase() as Network;

        const [dexData, securityReport] = await Promise.all([
          fetchDexData(address, network),
          fetchSecurityReport(network, address),
        ]);

        if (!dexData) {
          sendResponse({
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: `No active liquidity pools found for ${address} on ${network}.` }),
                },
              ],
              isError: true,
            },
          });
          return;
        }

        const alphaSignal = computeAlphaSignal(network, dexData, securityReport);
        sendResponse({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(alphaSignal, null, 2),
              },
            ],
          },
        });
        return;
      }

      if (toolName === 'get_polymarket_alpha') {
        const markets = await fetchPolymarketAlpha();
        sendResponse({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(markets, null, 2),
              },
            ],
          },
        });
        return;
      }

      sendResponse({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Tool not found: ${toolName}` },
      });
    }
  } catch (err: any) {
    sendResponse({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: `Parse error: ${err.message}` },
    });
  }
});

function sendResponse(response: any) {
  process.stdout.write(JSON.stringify(response) + '\n');
}
