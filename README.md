# 🚀 Alpha402 - HTTP 402 Real-Time On-Chain Alpha API for AI Agents

An autonomous, pay-per-request intelligence API built for **AI Agents**. Provides real-time DEX liquidity metrics, volume momentum spikes, anti-honeypot contract audits, and prediction market arbitrage opportunities via the **HTTP 402 Payment Required** standard.

Runs on **$0/month infrastructure** using Cloudflare Workers, free public Web3 APIs (DexScreener, GoPlus Security, Polymarket), and native micro-payment settlement (Bitcoin Lightning L402 & EVM/Base x402).

---

## 🛡️ Critical Fail-Closed & Reusable Credit Policy
For pre-swap checks, **failing open is a catastrophic bug**. If the upstream security auditor (GoPlus) times out (4s timeout), errors, or rate limits:
* `auditStatus` is set to `UNAVAILABLE` / `TIMEOUT`.
* `isHoneypot` is explicitly set to `null` (**NEVER** false).
* `alphaScore` strictly returns `null` (no numeric score is issued).
* `riskLevel` immediately defaults to `UNKNOWN`.
* **Atomic Nonce Rollback:** The worker automatically issues a `DEL alpha402:nonce:<proof>` to Redis. Since on-chain USDC has moved, this makes the payment proof a **reusable credit** (`reusableCredit: true, charged: false`). The agent can retry without repurchasing!

---

## 📊 Transparent AlphaScore Weighting & Methodology

$$\text{AlphaScore} = (\text{Security} \times 0.40) + (\text{Momentum} \times 0.35) + (\text{Liquidity} \times 0.25)$$

### 1. Security Score (0.40 Weight):
* Starts at 100 points.
* Deductions for risk items (unverified source code -20, high buy tax, high sell tax, mintable supply).
* **Hard Zero:** `isHoneypot === true` OR `ownerCanChangeBalance === true` sets $\text{AlphaScore} = 0$.
* **Audit Failure:** Unverified audits return $\text{AlphaScore} = \text{null}$.

### 2. Momentum Score with Pool Age & Wash Dampening (0.35 Weight):
* **Pool Age Discount:** Pools < 24 hours old have momentum discounted proportionally ($\text{poolAgeHours} / 24$).
* **Wash-Trading Zeroing:** If transaction density indicates wash trading (high volume on low tx count, or avg tx size > 15% of pool liquidity), $\text{MomentumScore} = 0$ (0 points awarded).

### 3. Liquidity Score (0.25 Weight):
* Scaled log-linearly: < $10k (0–20), $50k (50), $250k (80), > $1M (100).

---

## 🔒 Atomic Distributed Nonce Settlement
* Uses Upstash Redis REST API (`SET alpha402:nonce:<proof> 1 EX <ttl> NX`) before serving responses.
* Guarantees strict single-spend execution across distributed Cloudflare edge isolates.
* Automatic rollback (`DEL`) if upstream market or audit lookups cannot be fulfilled.
