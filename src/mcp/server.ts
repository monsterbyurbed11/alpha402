#!/usr/bin/env node
import app, { MCP_TOOLS } from '../index.js';
import { SUPPORTED_NETWORKS, isValidNetwork, isValidTokenAddress } from '../types.js';
import * as readline from 'readline';

/**
 * Model Context Protocol (MCP) Gateway Client for Alpha402
 * Routes all MCP tool executions through the HTTP 402 Paywall (never runs unauthenticated local scraping).
 * Supports:
 * - Prepaid Multi-Call Base USDC deposits (`ALPHA402_TX_HASH=0x...` or `paymentProof: "x402 0x..."`)
 * - Official Coinbase x402 (`ALPHA402_X_PAYMENT=<base64>` or `paymentProof: "<base64>"`)
 * - Lightning L402 (`paymentProof: "L402 <token>:<preimage>"`)
 */

const REMOTE_GATEWAY_URL = (
  process.env.ALPHA402_API_URL ||
  process.env.API_BASE ||
  'https://alpha402.monsterbyurbed11.workers.dev'
).replace(/\/$/, '');

// Session-cached payment proof so a $1.00 USDC prepaid deposit automatically powers subsequent MCP tool calls
let cachedSessionPaymentProof: string =
  process.env.ALPHA402_PAYMENT_PROOF ||
  (process.env.ALPHA402_TX_HASH ? `x402 ${process.env.ALPHA402_TX_HASH.trim()}` : '') ||
  process.env.ALPHA402_X_PAYMENT ||
  '';

function buildPaymentHeaders(rawProof?: string): Record<string, string> {
  const proof = (rawProof || cachedSessionPaymentProof || '').trim();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  if (!proof) return headers;

  if (proof.startsWith('x402 ') || proof.startsWith('L402 ')) {
    headers['Authorization'] = proof;
  } else if (/^0x[a-fA-F0-9]{64}$/.test(proof) || /^TEST_TX_/.test(proof)) {
    headers['Authorization'] = `x402 ${proof}`;
  } else {
    headers['X-PAYMENT'] = proof;
  }

  return headers;
}

async function callPaywalledGateway(
  path: string,
  paymentProof?: string
): Promise<{ status: number; data: any }> {
  const headers = buildPaymentHeaders(paymentProof);

  // If explicitly configured to use in-process Hono app (still enforces paywall402!) or remote gateway
  if (process.env.ALPHA402_USE_LOCAL_APP !== 'true') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(`${REMOTE_GATEWAY_URL}${path}`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      const data = await res.json();
      if (res.ok && paymentProof) {
        cachedSessionPaymentProof = paymentProof.trim();
      }
      return { status: res.status, data };
    } catch {
      // Fallback to in-process Hono app (which STILL enforces paywall402 with ENABLE_SANDBOX=false)
    } finally {
      clearTimeout(timeout);
    }
  }

  const localRes = await app.request(path, {
    method: 'GET',
    headers,
  });
  const localData = await localRes.json();
  if (localRes.ok && paymentProof) {
    cachedSessionPaymentProof = paymentProof.trim();
  }
  return { status: localRes.status, data: localData };
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

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
            version: '1.5.0',
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
        result: { tools: MCP_TOOLS },
      });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const args = params?.arguments || {};
      const paymentProof = typeof args.paymentProof === 'string' ? args.paymentProof : undefined;

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

        const endpointPath =
          toolName === 'check_token_security'
            ? `/v1/token-security?network=${encodeURIComponent(rawNetwork)}&address=${encodeURIComponent(address)}`
            : `/v1/token-alpha?network=${encodeURIComponent(rawNetwork)}&address=${encodeURIComponent(address)}`;

        const { status, data } = await callPaywalledGateway(endpointPath, paymentProof);
        sendResponse({
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(data, null, 2),
              },
            ],
            ...(status >= 400 ? { isError: true } : {}),
          },
        });
        return;
      }

      if (toolName === 'get_new_pairs_alpha') {
        const rawNetwork = String(args.network || 'base').toLowerCase();
        const limit = Number(args.limit) || 5;

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

        const endpointPath = `/v1/new-pairs?network=${encodeURIComponent(rawNetwork)}&limit=${encodeURIComponent(String(limit))}`;
        const { status, data } = await callPaywalledGateway(endpointPath, paymentProof);
        sendResponse({
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(data, null, 2),
              },
            ],
            ...(status >= 400 ? { isError: true } : {}),
          },
        });
        return;
      }

      if (toolName === 'get_polymarket_alpha') {
        const { status, data } = await callPaywalledGateway('/v1/polymarket-alpha', paymentProof);
        sendResponse({
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(data, null, 2),
              },
            ],
            ...(status >= 400 ? { isError: true } : {}),
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
