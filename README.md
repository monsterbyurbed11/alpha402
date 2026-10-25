# 🚀 Alpha402 - HTTP 402 Real-Time On-Chain Alpha API for AI Agents

An autonomous, pay-per-request intelligence API built for **AI Agents**. Provides real-time DEX liquidity metrics, volume momentum spikes, anti-honeypot contract audits, and prediction market arbitrage opportunities via the **HTTP 402 Payment Required** standard.

Runs on **$0/month infrastructure** using Cloudflare Workers, free public Web3 APIs (DexScreener, GoPlus Security, Polymarket), and native micro-payment settlement (Bitcoin Lightning L402 & EVM/Base x402).

---

## 🛡️ Critical Fail-Closed Security Policy
For pre-swap checks, **failing open is a catastrophic bug**. If the upstream security auditor (GoPlus) times out (4s timeout), errors, or rate limits:
* `auditStatus` is set to `UNAVAILABLE` / `TIMEOUT`.
* `isHoneypot` is explicitly set to `null` (**NEVER** false).
* `riskLevel` immediately defaults to `CRITICAL` or `HIGH`.
* `alphaScore` triggers a hard veto cap at `25/100`.
* The decision prompt explicitly advises: `AUDIT_UNAVAILABLE / FAIL-CLOSED. Upstream security check failed. Do NOT assume token is safe. Pre-swap check aborted.`

---

## 📊 Transparent AlphaScore Weighting & Methodology

The $0.02 fee covers real-time edge aggregation, anti-honeypot parsing, and composite scoring. The score is computed as:

$$\text{AlphaScore} = (\text{Security} \times 0.40) + (\text{Momentum} \times 0.35) + (\text{Liquidity} \times 0.25)$$

### 1. Security Score (40% Weight):
* Starts at 100 points.
* Deductions for risk items (unverified source code -20, high buy tax, high sell tax, mintable supply).
* **Hard Veto:** `isHoneypot === true` forces $\text{AlphaScore} = 0$.
* **Audit Failure Veto:** Unverified audits or malicious owner permissions cap score at 25.

### 2. Momentum Score (35% Weight):
* Analyzes 1h price trend (+/- points up to 25).
* Buy pressure multiplier (1h buys vs 1h sells; > 1.5x gives +15 points, < 0.6x deducts 15 points).
* Volume acceleration: 5m volume annualized vs 1h average (> 2.0x multiplier adds momentum bonus).

### 3. Liquidity Score (25% Weight):
* Scaled log-linearly: < $10k (0–20), $50k (50), $250k (80), > $1M (100).

---

## 🔒 Replay Nonce & Double-Spend Architecture
* **Edge In-Memory Nonce Cache:** Fast isolate tracking.
* **Production Atomic Settlement:** Supports Upstash Redis (`SET key EX 86400 NX`) and Cloudflare Durable Objects for single-threaded globally consistent nonce settlement across concurrent edge requests.

---

## 📡 API Endpoints & Schemas

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
    "alphaScore": 77,
    "riskLevel": "MEDIUM",
    "signals": {
      "momentumScore": 35,
      "securityScore": 100,
      "liquidityScore": 100,
      "buyPressureRatio1h": 0.25,
      "volumeSpike5mVs1hAvg": 1.15
    },
    "marketSummary": {
      "priceUsd": 0.0047,
      "priceChange1h": -1.2,
      "priceChange24h": 4.8,
      "liquidityUsd": 1125284,
      "fdv": 47000000,
      "volume24h": 1200000
    },
    "securityAudit": {
      "auditStatus": "VERIFIED",
      "isHoneypot": false,
      "buyTax": "0.0%",
      "sellTax": "0.0%",
      "isOpenSource": true,
      "warnings": []
    },
    "scoringMethodology": {
      "weights": {
        "securityWeight": "40%",
        "momentumWeight": "35%",
        "liquidityWeight": "25%"
      },
      "vetoConditions": [
        "isHoneypot === true -> AlphaScore capped at 0",
        "ownerCanChangeBalance === true -> AlphaScore capped at 25",
        "auditStatus !== VERIFIED -> AlphaScore capped at 25 (Fail-closed)"
      ]
    },
    "agentActionableSummary": "MONITOR / PASS. Contract is safe, but bearish selling pressure detected (1 buys vs 4 sells in 1h)."
  }
}
```

### 2. `GET /openapi.json`
Full typed OpenAPI 3.1 specification including all components, parameter definitions, and typed response schemas.
