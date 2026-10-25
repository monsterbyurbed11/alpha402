#!/usr/bin/env node
import { fetchDexData } from '../services/dexscreener.js';
import { fetchSecurityReport } from '../services/goplus.js';
import { fetchPolymarketAlpha } from '../services/polymarket.js';
import { computeAlphaSignal } from '../services/alphaEngine.js';
import { Network, SUPPORTED_NETWORKS, isValidNetwork, isValidTokenAddress } from '../types.js';
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
      'Fast fail-closed anti-honeypot and smart contract security audit (checks honeypots, high buy/sell tax, blacklist, freeze authority, balance modification). Micro-tier: $0.005.',
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
      },
      required: ['address'],
    },
  },
  {
    name: 'get_token_alpha',
    description:
      'Performs fail-closed real-time security audit (is_honeypot, sell taxes, balance modifications), volume momentum analysis, and liquidity depth scoring for any token. Supports Base, Solana, Ethereum, BSC, Arbitrum, Polygon.',
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

  let request: any;
  try {
    request = JSON.parse(line);
  } catch (err: any) {
    sendResponse({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: `Parse error: ${err?.message || 'Invalid JSON'}` },
    });
    return;
  }

  const { id, method, params } = request || {};

  try {
    if (method === 'initialize') {
      sendResponse({
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'alpha402-intelligence-mcp',
            version: '1.4.0',
          },
        },
      });
      return;
    }

    if (method === 'notifications/initialized') {
      return;
    }

    if (method === 'ping') {
      sendResponse({
        jsonrpc: '2.0',
        id: id ?? null,
        result: {},
      });
      return;
    }

    if (method === 'tools/list') {
      sendResponse({
        jsonrpc: '2.0',
        id: id ?? null,
        result: { tools: TOOLS },
      });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const args = params?.arguments || {};

      if (toolName === 'check_token_security' || toolName === 'get_token_alpha') {
        const rawNetwork = String(args.network || 'base').toLowerCase();
        const address = typeof args.address === 'string' ? args.address.trim() : '';

        if (!isValidNetwork(rawNetwork)) {
          sendResponse({
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
          return;
        }

        if (!isValidTokenAddress(rawNetwork, address)) {
          sendResponse({
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
          return;
        }

        const network: Network = rawNetwork;

        if (toolName === 'check_token_security') {
          const securityReport = await fetchSecurityReport(network, address);
          const isVerified = securityReport.auditStatus === 'VERIFIED';
          sendResponse({
            jsonrpc: '2.0',
            id: id ?? null,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(securityReport, null, 2),
                },
              ],
              ...(isVerified ? {} : { isError: true }),
            },
          });
          return;
        }

        if (toolName === 'get_token_alpha') {
          const [dexData, securityReport] = await Promise.all([
            fetchDexData(address, network),
            fetchSecurityReport(network, address),
          ]);

          if (!dexData) {
            sendResponse({
              jsonrpc: '2.0',
              id: id ?? null,
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

          if (securityReport.auditStatus !== 'VERIFIED') {
            sendResponse({
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
                        warnings: securityReport.warnings,
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
            return;
          }

          const alphaSignal = computeAlphaSignal(network, dexData, securityReport);
          sendResponse({
            jsonrpc: '2.0',
            id: id ?? null,
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
      }

      if (toolName === 'get_polymarket_alpha') {
        const markets = await fetchPolymarketAlpha();
        if (!markets) {
          sendResponse({
            jsonrpc: '2.0',
            id: id ?? null,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: 'Polymarket upstream service unavailable or timed out.' }),
                },
              ],
              isError: true,
            },
          });
          return;
        }

        sendResponse({
          jsonrpc: '2.0',
          id: id ?? null,
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
        id: id ?? null,
        error: { code: -32601, message: `Tool not found: ${String(toolName)}` },
      });
      return;
    }

    if (id !== undefined) {
      sendResponse({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${String(method)}` },
      });
    }
  } catch (err: any) {
    sendResponse({
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code: -32603, message: `Internal error: ${err?.message || 'Unknown error'}` },
    });
  }
});

function sendResponse(response: any) {
  process.stdout.write(JSON.stringify(response) + '\n');
}
