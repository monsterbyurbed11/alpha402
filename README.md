# 🚀 Alpha402 — DexScreener, GoPlus Honeypot Security & Polymarket Alpha MCP

[![Glama MCP Server](https://glama.ai/mcp/servers/monsterbyurbed11/alpha402/badge)](https://glama.ai/mcp/servers/monsterbyurbed11/alpha402)
[![npm version](https://img.shields.io/npm/v/alpha402-mcp.svg)](https://www.npmjs.com/package/alpha402-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![M8ven Score](https://m8ven.ai/badge/mcp/monsterbyurbed11-alpha402-16f2fi?v=0dd7b7032645e2e041c7f79d7223fbc2)](https://m8ven.ai/mcp/monsterbyurbed11-alpha402-16f2fi?s=readme)

Real-time **DexScreener** liquidity & momentum metrics, **GoPlus** fail-closed anti-honeypot smart contract security audits, newly active safe pool discovery (`/v1/new-pairs` + SSE stream), and **Polymarket** prediction market arbitrage opportunities for autonomous **AI Agents** across **Base, Solana, Ethereum, BSC, Arbitrum, and Polygon**.

* 🎁 **Zero-Config Free Tier (3 Free Calls / Day)**: Start immediately in Claude Desktop, Cursor, Glama, or Smithery with **no wallet setup required** for your first 3 queries every day.
* ⚡ **Instant Prepaid Base USDC Credits (`$1.00 = 200 Security Audits / 50 Alpha Calls`)**: Send `$1.00 USDC` once on Base to `0x8a8c238ed2b46908Ff6C6922a3870984f20f8913` and pass your transaction hash (`0x...`) for sub-20ms credit deduction and zero RPC wait time on subsequent calls.
* 🪙 **Official Coinbase `x402` Standard (`x402Version: 1`) & Lightning `L402`**: Compatible out-of-the-box with `x402-fetch`, `x402-axios`, and Coinbase CDP AgentKit.

🌐 **Live Production Gateway**: `https://alpha402.acter.workers.dev`  
📊 **Live Funnel & Revenue Analytics**: `https://alpha402.acter.workers.dev/v1/analytics`

---

## 📦 Quick Start: MCP Server (Claude Desktop, Cursor, Cline, Windsurf, Glama)

Run immediately via `npx` (first **3 calls/day are 100% free**; optionally add `ALPHA402_TX_HASH` for unlimited prepaid calls):

```json
{
  "mcpServers": {
    "alpha402": {
      "command": "npx",
      "args": ["-y", "alpha402-mcp"],
      "env": {
        "ALPHA402_TX_HASH": "0x_OPTIONAL_PREPAID_BASE_USDC_TX_HASH"
      }
    }
  }
}
```

### Available MCP Tools & REST Endpoints
| Tool / Endpoint | Free Tier | Unlimited Price | Description |
| :--- | :--- | :--- | :--- |
| `check_token_security` / `GET /v1/token-security` | **3 Free / Day** | **$0.005 USDC** (5 sats) | Fast fail-closed GoPlus contract audit (honeypot, buy/sell tax, balance mod, freeze authority). |
| `get_token_alpha` / `GET /v1/token-alpha` | **3 Free / Day** | **$0.02 USDC** (20 sats) | Full composite AlphaScore (Security 40% + Momentum 35% + Liquidity 25%) + wash-trading filter. |
| `get_new_pairs_alpha` / `GET /v1/new-pairs` | **3 Free / Day** | **$0.02 USDC** (20 sats) | Scans newly active & boosted pools on Base/Solana/ETH/BSC/Arb/Polygon, filters out honeypots, and ranks safe pools by AlphaScore. |
| `GET /v1/new-pairs/stream` | **3 Free / Day** | **$0.02 USDC** (20 sats) | Real-time Server-Sent Events (`text/event-stream`) feed of verified safe new pairs. |
| `get_polymarket_alpha` / `GET /v1/polymarket-alpha` | **3 Free / Day** | **$0.01 USDC** (10 sats) | Top volume prediction markets, outcome prices, and binary arbitrage spreads. |
| `get_credits_and_payment_info` / `GET /v1/credits` | **Always Free** | **$0.00 (Free)** | Check remaining prepaid USDC credit balance for any `0x...` txHash or get deposit instructions. |

---

## ⚡ Instant Multi-Call Prepaid Credits (Built for High-Speed Trading Bots)
Per-request on-chain transfers are too slow for sniper bots. Alpha402 solves this automatically:
1. Send any amount $\ge \$0.005$ USDC on Base to `0x8a8c238ed2b46908Ff6C6922a3870984f20f8913` (e.g., **$1.00 USDC** = `1,000,000` units).
2. Pass `paymentProof: "0x<your_tx_hash>"` in any MCP tool call or `Authorization: x402 0x<your_tx_hash>` on REST requests.
3. **Call #1** verifies the receipt on Base RPC and initializes your credit balance (`$0.98` remaining = 49 more alpha calls or 196 security calls).
4. **Subsequent Calls** skip Base RPC completely and deduct credits in **< 20ms**, returning `X-402-Credits-Remaining-USDC` and `X-402-Calls-Remaining` headers on every response!

---

## 🛡️ Critical Fail-Closed & Automatic Credit Refund Policy
For pre-swap checks, **failing open is a catastrophic bug**. If the upstream security auditor (GoPlus) times out (4s timeout), errors, or cannot verify a contract:
* `auditStatus` is set to `UNAVAILABLE` / `TIMEOUT`.
* HTTP `503 Service Unavailable` is returned and market data is withheld (`data: null`).
* **Atomic Credit Refund:** The worker automatically refunds your exact call cost (`reusableCredit: true, charged: false`).
