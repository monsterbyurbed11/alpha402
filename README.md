# 🚀 Alpha402 - HTTP 402 Real-Time On-Chain Alpha API for AI Agents

[![Glama MCP](https://glama.ai/mcp/badge)](https://glama.ai/mcp/servers)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![HTTP 402](https://img.shields.io/badge/Payment-HTTP%20402%20(x402%20%2F%20L402)-blue)](https://x402.org)

An autonomous, pay-per-request intelligence API built for **AI Agents**. Provides real-time DEX liquidity metrics, volume momentum spikes, anti-honeypot contract audits, and prediction market arbitrage opportunities via the **HTTP 402 Payment Required** standard.

Runs on **$0/month infrastructure** using Cloudflare Workers, free public Web3 APIs (DexScreener, GoPlus Security, Polymarket), and native micro-payment settlement (Bitcoin Lightning L402 & EVM/Base x402). Includes **3 free demo trial queries** per client (`?demo=true`) for easy testing in registries like Glama and Smithery.

---

## 💎 Tiered Micro-Pricing Architecture

Built for different agent frequencies—from high-throughput memecoin scanners to strategic deep-dive traders:

| Endpoint / Tool | Price (USDC / Sats) | Target Agent Use-Case |
| :--- | :--- | :--- |
| **`GET /v1/security-check`** (`check_token_security`) | **$0.005** / 5 sats | **High-Frequency Scanners**: Rapid honeypot, blacklist, sell tax, and freeze check. |
| **`GET /v1/token-alpha`** (`get_token_alpha`) | **$0.020** / 20 sats | **Trade Decision Engine**: Full Alpha Score (0-100), volume momentum spike, buy/sell ratios, and LLM summary prompt. |
| **`GET /v1/polymarket-alpha`** (`get_polymarket_alpha`) | **$0.010** / 10 sats | **Arbitrage Bots**: High-volume event predictions, binary spreads, and resolution dates. |
| **Free Sandbox Trial** | **$0.000** (First 3 queries) | **Developer & Registry Sandbox**: Add `?demo=true` for 3 instant zero-crypto test calls. |

---

## 🌟 Key Features

1. **HTTP 402 Paywall Layer with 3 Free Demo Trials:**
   * Returns `402 Payment Required` with `WWW-Authenticate: L402` and `x402` headers when no payment is present.
   * New developers & testing agents can pass `?demo=true` to test up to 3 queries for free (`X-Demo-Remaining: 2`, `1`, `0`).
   * Once exhausted, autonomous AI agents pay micro-transactions ($0.005–$0.02 USDC or sats) and retry with payment proof in the `Authorization` header.
   * Built-in nonce tracking to prevent replay attacks and double-spending.

2. **Real-Time On-Chain Alpha & Anti-Honeypot Engine:**
   * **Security Audit:** Detects honeypots, unverified source code, high buy/sell taxes (>10%), blacklists, owner balance modification permissions, and whale concentration via GoPlus Security.
   * **Momentum & Liquidity Scoring:** Analyzes 5m vs 1h volume acceleration, 1h buy/sell transaction pressure ratios, and pool depth via DexScreener.
   * **LLM-Targeted Actionable Output:** Pre-computes a 0–100 Alpha Score and structured summary prompt designed specifically for trading agents' context windows.

3. **Polymarket Prediction Arbitrage:**
   * Tracks high-volume prediction markets, event resolution dates, and binary spread opportunities.

4. **Model Context Protocol (MCP) Server:**
   * Fully indexed for **Glama** and **Smithery** with both stdio (`src/mcp/server.ts`) and remote HTTP (`POST /mcp`) transports.

---

## 🛠️ $0 Tech Stack Breakdown

* **API & Compute:** [Cloudflare Workers](https://workers.cloudflare.com/) (Free tier: 100,000 requests/day).
* **Framework:** [Hono](https://hono.dev/) (Ultra-fast web framework with native edge and Node.js support).
* **On-Chain Data Sources:** 
  * [DexScreener Public API](https://docs.dexscreener.com/api/reference) ($0, no key needed)
  * [GoPlus Security API](https://gopluslabs.io/) ($0 free tier)
  * [Polymarket CLOB/Gamma API](https://docs.polymarket.com/) ($0 public API)
* **Payment Protocols:**
  * **L402 (Lightning):** [Alby Developer](https://getalby.com/) or LNbits.
  * **x402 (Base USDC):** [Coinbase AgentKit](https://docs.cdp.coinbase.com/agentkit/docs/welcome) / Alchemy Free RPC.

---

## 🚀 Quickstart & Local Testing

### 1. Start the API Server
```bash
npm start
```
The server will start on `http://localhost:8402`.

### 2. Test with the Simulated AI Agent
In a separate terminal, run:
```bash
npm run test-agent
```
**What happens in the simulation:**
1. The agent queries `GET /v1/token-alpha?network=base&address=0x532f27101965dd16442e59d40670faf5ebb142e4` (BRETT on Base) without payment.
2. The server responds with `HTTP 402 Payment Required` and a challenge payload.
3. The simulated agent wallet fulfills the challenge and receives an authorization token.
4. The agent resubmits with `Authorization: L402 <token>:<preimage>`.
5. The server validates the payment and returns the computed Alpha Signal.

---

## 📡 API Endpoints

### 1. `GET /v1/token-alpha` (Protected by 402 Paywall)
* **Query Parameters:**
  * `address` (required): Smart contract address or token mint address.
  * `network` (optional): `base` (default), `solana`, `ethereum`, `bsc`, `arbitrum`, `polygon`.
  * `demo` (optional): Set `demo=true` for free sandbox testing.

* **Response Example (200 OK):**
```json
{
  "success": true,
  "paymentVerifiedBy": "L402_Lightning",
  "data": {
    "token": {
      "symbol": "BRETT",
      "name": "Brett",
      "address": "0x532f27101965dd16442e59d40670faf5ebb142e4",
      "network": "base"
    },
    "alphaScore": 88,
    "riskLevel": "LOW",
    "signals": {
      "momentumScore": 82,
      "securityScore": 100,
      "liquidityScore": 95,
      "buyPressureRatio1h": 1.74,
      "volumeSpike5mVs1hAvg": 2.15
    },
    "marketSummary": {
      "priceUsd": 0.084,
      "priceChange1h": 3.2,
      "priceChange24h": 12.8,
      "liquidityUsd": 3845000,
      "fdv": 840000000,
      "volume24h": 18200000
    },
    "securityAudit": {
      "isHoneypot": false,
      "buyTax": "0.0%",
      "sellTax": "0.0%",
      "isOpenSource": true,
      "warnings": []
    },
    "agentActionableSummary": "STRONG MOMENTUM SIGNAL. Buy ratio is 1.7x with clean security audit. 1h price trend is +3.2%."
  }
}
```

### 2. `GET /v1/polymarket-alpha` (Protected by 402 Paywall)
Returns high-volume prediction market contracts, outcomes, and spread arbitrage opportunities.

### 3. `GET /.well-known/agent.json` (Free Discovery)
Machine-readable metadata file conforming to agent discovery standards.

### 4. `GET /openapi.json` (Free Discovery)
Standard OpenAPI 3.1 specification for automatic tool parsing in LangChain, CrewAI, AutoGen, etc.

---

## 🚢 Zero-Cost Deployment to Cloudflare Workers

1. Log in to your free Cloudflare account:
```bash
npx wrangler login
```

2. Deploy globally in seconds:
```bash
npx wrangler deploy
```
Your API will be live instantly at `https://alpha402.<your-subdomain>.workers.dev` with 100,000 free requests per day.

---

## 🌐 Publishing Where AI Agents Can Find & Consume It

To get autonomous agents calling and paying for your API:

1. **Smithery.ai & Glama.ai (MCP Directories):**
   * Register your `src/mcp/server.ts` as an MCP server.
   * Users and agents in Claude Desktop, Cursor, and Windsurf can install it with one command:
     ```bash
     npx -y alpha402-mcp
     ```

2. **Coinbase AgentKit (EVM / Base Agents):**
   * Submit your endpoint to the AgentKit tool repository.
   * Agents carrying Base CDP wallets can directly use your API via `x402`.

3. **ElizaOS Plugin:**
   * Package as an Eliza plugin (`@elizaos/plugin-alpha402`) so Twitter/Discord trading agents can query it before executing swaps.

4. **LangChain Hub / CrewAI Tools:**
   * Publish a Python/TypeScript wrapper package pointing to your OpenAPI URL (`https://your-worker.workers.dev/openapi.json`).
