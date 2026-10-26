# 🚀 Alpha402 - HTTP 402 Real-Time On-Chain Alpha API & MCP for AI Agents

An autonomous, pay-per-request and **instant prepaid session** intelligence API built for **AI Agents**. Provides real-time DEX liquidity metrics, newly active safe pool discovery (`/v1/new-pairs` + SSE stream), volume momentum spikes, fail-closed anti-honeypot contract audits, and prediction market arbitrage opportunities via the **HTTP 402 Payment Required** standard.

Supports:
* **Official Coinbase `x402` Standard (`x402Version: 1`)**: Compatible out-of-the-box with `x402-fetch`, `x402-axios`, and Coinbase CDP AgentKit via the `X-PAYMENT` & `X-PAYMENT-RESPONSE` headers.
* **Zero-Latency Multi-Call Prepaid Base USDC Credits**: Send `$1.00 USDC` once on Base and get **50 instant `/v1/token-alpha` calls** (or **200 `/v1/token-security` calls**) on the same `Authorization: x402 <tx_hash>` with **sub-20ms Redis Lua atomic deduction** and **zero Base RPC wait time** on subsequent calls!
* **Lightning Network `L402`**: HMAC-SHA256 signed challenge tokens + full 256-bit `SHA-256(preimage)` verification.

---

## 📦 Quick Start: MCP Server (Claude Desktop, Cursor, Cline, Windsurf)

Install and run via `npx`:

```json
{
  "mcpServers": {
    "alpha402": {
      "command": "npx",
      "args": ["-y", "alpha402-mcp"],
      "env": {
        "ALPHA402_TX_HASH": "0x_YOUR_PREPAID_BASE_USDC_TX_HASH"
      }
    }
  }
}
```

### Available MCP Tools & REST Endpoints
| Tool / Endpoint | Price | Description |
| :--- | :--- | :--- |
| `check_token_security` / `GET /v1/token-security` | **$0.005 USDC** (5 sats) | Fast fail-closed contract audit (honeypot, buy/sell tax, balance mod, freeze authority). |
| `get_token_alpha` / `GET /v1/token-alpha` | **$0.02 USDC** (20 sats) | Full composite AlphaScore (Security 40% + Momentum 35% + Liquidity 25%) + wash-trading filter. |
| `get_new_pairs_alpha` / `GET /v1/new-pairs` | **$0.02 USDC** (20 sats) | Scans newly active & boosted pools on Base/Solana/ETH/BSC/Arb/Polygon, filters out honeypots, and ranks safe pools by AlphaScore. |
| `GET /v1/new-pairs/stream` | **$0.02 USDC** (20 sats) | Real-time Server-Sent Events (`text/event-stream`) feed of verified safe new pairs. |
| `get_polymarket_alpha` / `GET /v1/polymarket-alpha` | **$0.01 USDC** (10 sats) | Top volume prediction markets, outcome prices, and binary arbitrage spreads. |

---

## ⚡ Instant Multi-Call Prepaid Credits (Built for High-Speed Trading Bots)
Per-request on-chain transfers are too slow for sniper bots. Alpha402 solves this automatically:
1. Send any amount $\ge \$0.005$ USDC on Base to `0x8a8c238ed2b46908Ff6C6922a3870984f20f8913` (e.g., **$1.00 USDC** = `1,000,000` units).
2. Pass `Authorization: x402 0x<your_tx_hash>` on every request.
3. **Call #1** verifies the receipt on Base RPC and initializes your credit balance (`$0.98` remaining = 49 more alpha calls) in Upstash Redis.
4. **Calls #2–#50** skip Base RPC completely and deduct credits atomically in Redis via Lua `EVAL` in **< 20ms**, returning `X-402-Credits-Remaining-USDC` and `X-402-Calls-Remaining` headers on every response!

---

## 🛡️ Critical Fail-Closed & Automatic Credit Refund Policy
For pre-swap checks, **failing open is a catastrophic bug**. If the upstream security auditor (GoPlus) times out (4s timeout), errors, or cannot verify a contract:
* `auditStatus` is set to `UNAVAILABLE` / `TIMEOUT`.
* HTTP `503 Service Unavailable` is returned and market data is withheld (`data: null`).
* **Atomic Credit Refund:** The worker automatically refunds your exact call cost in Redis (`INCRBY` for prepaid `x402` credits, or `DEL` for single-use nonces), setting `reusableCredit: true, charged: false`.
