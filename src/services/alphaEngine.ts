import { DexPairData, SecurityReport, TokenAlphaSignal, Network } from '../types.js';

export function computeAlphaSignal(
  network: Network,
  dexData: DexPairData,
  security: SecurityReport
): TokenAlphaSignal {
  const isAuditVerified = security.auditStatus === 'VERIFIED';

  // 1. Security Score (0 - 100 or null)
  let securityScore: number | null = null;
  if (isAuditVerified) {
    if (security.isHoneypot === true) {
      securityScore = 0;
    } else if (security.ownerCanChangeBalance) {
      securityScore = 5;
    } else {
      let score = 100 - (security.riskCount * 8);
      if (!security.isOpenSource) score -= 20;
      if (security.buyTax > 5) score -= (security.buyTax - 5) * 2;
      if (security.sellTax > 5) score -= (security.sellTax - 5) * 3;
      if (security.isMintable) score -= 10;
      securityScore = Math.max(0, Math.min(100, Math.round(score)));
    }
  }

  // 2. Liquidity Score (0 - 100)
  let liquidityScore = 0;
  const liq = dexData.liquidityUsd;
  if (liq < 10000) liquidityScore = Math.round((liq / 10000) * 20);
  else if (liq < 50000) liquidityScore = 20 + Math.round(((liq - 10000) / 40000) * 30);
  else if (liq < 250000) liquidityScore = 50 + Math.round(((liq - 50000) / 200000) * 30);
  else if (liq < 1000000) liquidityScore = 80 + Math.round(((liq - 250000) / 750000) * 20);
  else liquidityScore = 100;

  // 3. Pool Age & Wash Trading Heuristics
  let poolAgeHours: number | null = null;
  if (dexData.pairCreatedAt) {
    poolAgeHours = parseFloat(((Date.now() - dexData.pairCreatedAt) / (1000 * 60 * 60)).toFixed(1));
  }

  // Wash-trading heuristic:
  // High 5m volume with very few transactions, or new pool (<2 hours) with massive spike
  const tx5mTotal = (dexData.txns.m5.buys || 0) + (dexData.txns.m5.sells || 0);
  const avgTxSize5m = tx5mTotal > 0 ? dexData.volume.m5 / tx5mTotal : 0;
  const possibleWashTrading =
    (dexData.volume.m5 > 5000 && tx5mTotal <= 3) ||
    (poolAgeHours !== null && poolAgeHours < 2 && dexData.volume.m5 > 20000 && tx5mTotal < 10) ||
    (avgTxSize5m > 0 && avgTxSize5m > dexData.liquidityUsd * 0.25);

  // 4. Momentum Score with Wash-Trading Dampening (0 - 100)
  const buys1h = dexData.txns.h1.buys;
  const sells1h = dexData.txns.h1.sells;
  const totalTx1h = buys1h + sells1h;
  const buyRatio1h = totalTx1h > 0 ? buys1h / Math.max(1, sells1h) : 1;

  const vol5mExpected = dexData.volume.h1 / 12;
  const volumeSpikeMultiplier = vol5mExpected > 0 ? dexData.volume.m5 / vol5mExpected : 1;

  let rawMomentum = 50;
  if (dexData.priceChange.h1 > 0) {
    rawMomentum += Math.min(25, dexData.priceChange.h1 * 0.8);
  } else {
    rawMomentum -= Math.min(30, Math.abs(dexData.priceChange.h1) * 0.9);
  }

  if (buyRatio1h > 1.5) rawMomentum += 15;
  else if (buyRatio1h < 0.6) rawMomentum -= 15;

  if (volumeSpikeMultiplier > 2.0) rawMomentum += 10;

  // Dampen momentum if wash trading or ultra-fresh pool is detected
  if (possibleWashTrading) {
    rawMomentum = Math.min(rawMomentum, 35); // Veto false momentum from wash-trading
  } else if (poolAgeHours !== null && poolAgeHours < 6) {
    rawMomentum = Math.min(rawMomentum, 60); // Cap fresh pool momentum
  }
  const momentumScore = Math.max(0, Math.min(100, Math.round(rawMomentum)));

  // 5. AlphaScore: NULL if audit failed; otherwise weighted sum
  let alphaScore: number | null = null;
  if (isAuditVerified && securityScore !== null) {
    if (security.isHoneypot === true) {
      alphaScore = 0;
    } else {
      alphaScore = Math.round((securityScore * 0.40) + (momentumScore * 0.35) + (liquidityScore * 0.25));
      if (security.ownerCanChangeBalance === true) {
        alphaScore = Math.min(alphaScore, 10);
      }
    }
  }

  // 6. Risk Level
  let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN' = 'LOW';
  if (!isAuditVerified) {
    riskLevel = 'UNKNOWN';
  } else if (security.isHoneypot || (securityScore !== null && securityScore < 30)) {
    riskLevel = 'CRITICAL';
  } else if (possibleWashTrading || (securityScore !== null && securityScore < 60) || liquidityScore < 30) {
    riskLevel = 'HIGH';
  } else if ((securityScore !== null && securityScore < 80) || momentumScore < 40) {
    riskLevel = 'MEDIUM';
  }

  // 7. Decision Prompt
  let actionAdvice = '';
  if (!isAuditVerified) {
    actionAdvice = `AUDIT_UNAVAILABLE. Upstream security provider timed out or failed. alphaScore: null. Payment proof NOT consumed. Aborting pre-swap check.`;
  } else if (security.isHoneypot) {
    actionAdvice = `REJECT / ABORT. Token confirmed as HONEYPOT. Sell is blocked!`;
  } else if (possibleWashTrading) {
    actionAdvice = `SUSPECTED WASH TRADING. High volume spike on low transaction count (${tx5mTotal} tx in 5m). Momentum discounted. Exercise caution.`;
  } else if (riskLevel === 'CRITICAL') {
    actionAdvice = `CRITICAL RISK (${security.warnings.join('; ')}). Abort transaction.`;
  } else if (alphaScore !== null && alphaScore > 75 && momentumScore > 70) {
    actionAdvice = `STRONG MOMENTUM SIGNAL. Verified contract, clean liquidity, buy ratio is ${buyRatio1h.toFixed(1)}x.`;
  } else if (momentumScore < 45) {
    actionAdvice = `MONITOR / PASS. Contract safe, but selling pressure detected (${buys1h} buys vs ${sells1h} sells in 1h).`;
  } else {
    actionAdvice = `NEUTRAL / ACCUMULATING. Stable price action and verified contract. Normal liquidity depth.`;
  }

  return {
    token: {
      symbol: dexData.baseToken.symbol,
      name: dexData.baseToken.name,
      address: dexData.baseToken.address,
      network,
    },
    alphaScore,
    riskLevel,
    signals: {
      momentumScore,
      securityScore,
      liquidityScore,
      buyPressureRatio1h: parseFloat(buyRatio1h.toFixed(2)),
      volumeSpike5mVs1hAvg: parseFloat(volumeSpikeMultiplier.toFixed(2)),
      poolAgeHours,
      possibleWashTrading,
    },
    marketSummary: {
      priceUsd: dexData.priceUsd,
      priceChange1h: dexData.priceChange.h1,
      priceChange24h: dexData.priceChange.h24,
      liquidityUsd: Math.round(dexData.liquidityUsd),
      fdv: Math.round(dexData.fdv),
      volume24h: Math.round(dexData.volume.h24),
    },
    securityAudit: {
      auditStatus: security.auditStatus,
      isHoneypot: security.isHoneypot,
      buyTax: security.buyTax,
      sellTax: security.sellTax,
      buyTaxBps: security.buyTaxBps,
      sellTaxBps: security.sellTaxBps,
      isOpenSource: security.isOpenSource,
      warnings: security.warnings,
    },
    scoringMethodology: {
      weights: {
        securityWeight: '40%',
        momentumWeight: '35%',
        liquidityWeight: '25%',
      },
      vetoConditions: [
        'auditStatus !== VERIFIED -> alphaScore = null (No score issued)',
        'isHoneypot === true -> alphaScore = 0',
        'possibleWashTrading === true -> momentum capped at 35',
        'ownerCanChangeBalance === true -> alphaScore capped at 10',
      ],
    },
    agentActionableSummary: actionAdvice,
    timestamp: new Date().toISOString(),
  };
}
