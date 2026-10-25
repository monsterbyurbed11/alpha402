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
    if (security.isHoneypot === true || security.ownerCanChangeBalance === true) {
      securityScore = 0; // Hard zero for honeypots or balance modification
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

  // 3. Pool Age & Age-Graduated Discounting
  let poolAgeHours: number | null = null;
  let poolAgeDiscountApplied = 1.0;
  if (dexData.pairCreatedAt) {
    poolAgeHours = parseFloat(((Date.now() - dexData.pairCreatedAt) / (1000 * 60 * 60)).toFixed(1));
    // Pools < 24h old get momentum dampened proportionally to their age (e.g. 2h pool = 2/24 = 0.083 -> capped at 0.1 min)
    poolAgeDiscountApplied = parseFloat(Math.min(1.0, Math.max(0.1, poolAgeHours / 24)).toFixed(2));
  } else {
    poolAgeDiscountApplied = 0.5; // Unknown creation date receives conservative 50% discount
  }

  // 4. Wash-Trading Heuristics
  // Catches: 
  // - High 5m volume with low transaction counts (<= 3 txns)
  // - Unusually large avg transaction size (> 15% of total pool liquidity)
  // - Low trade count in 1h with high volume (> 2x liquidity with < 20 transactions)
  const tx5mTotal = (dexData.txns.m5.buys || 0) + (dexData.txns.m5.sells || 0);
  const tx1hTotal = (dexData.txns.h1.buys || 0) + (dexData.txns.h1.sells || 0);
  const avgTxSize5m = tx5mTotal > 0 ? dexData.volume.m5 / tx5mTotal : 0;

  const possibleWashTrading =
    (dexData.volume.m5 > 5000 && tx5mTotal <= 3) ||
    (avgTxSize5m > 0 && avgTxSize5m > dexData.liquidityUsd * 0.15) ||
    (dexData.volume.h1 > dexData.liquidityUsd * 2 && tx1hTotal < 20);

  // 5. Momentum Score (0 - 100)
  const buys1h = dexData.txns.h1.buys;
  const sells1h = dexData.txns.h1.sells;
  const buyRatio1h = tx1hTotal > 0 ? buys1h / Math.max(1, sells1h) : 1;

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

  // Apply pool age dampening
  rawMomentum = rawMomentum * poolAgeDiscountApplied;

  // HARD ZERO on wash trading: zero points awarded to momentum
  let momentumScore = Math.max(0, Math.min(100, Math.round(rawMomentum)));
  if (possibleWashTrading) {
    momentumScore = 0; // 0 points awarded, eliminates the 12pt loophole
  }

  // 6. AlphaScore: NULL if audit failed, 0 if honeypot or owner balance modification
  let alphaScore: number | null = null;
  if (isAuditVerified && securityScore !== null) {
    if (security.isHoneypot === true || security.ownerCanChangeBalance === true) {
      alphaScore = 0; // Hard ZERO
    } else {
      alphaScore = Math.round((securityScore * 0.40) + (momentumScore * 0.35) + (liquidityScore * 0.25));
    }
  }

  // 7. Risk Level
  let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN' = 'LOW';
  if (!isAuditVerified) {
    riskLevel = 'UNKNOWN';
  } else if (security.isHoneypot || security.ownerCanChangeBalance || (securityScore !== null && securityScore < 30)) {
    riskLevel = 'CRITICAL';
  } else if (possibleWashTrading || (securityScore !== null && securityScore < 60) || liquidityScore < 30) {
    riskLevel = 'HIGH';
  } else if ((securityScore !== null && securityScore < 80) || momentumScore < 40) {
    riskLevel = 'MEDIUM';
  }

  // 8. Decision Prompt
  let actionAdvice = '';
  if (!isAuditVerified) {
    actionAdvice = `AUDIT_UNAVAILABLE. Upstream security check failed. alphaScore: null. Reusable credit preserved (proof NOT consumed). Aborting pre-swap check.`;
  } else if (security.isHoneypot) {
    actionAdvice = `REJECT / ABORT. Token confirmed as HONEYPOT. Sell is blocked!`;
  } else if (security.ownerCanChangeBalance) {
    actionAdvice = `CRITICAL RISK. Contract owner has balance-modification permissions. alphaScore: 0. Abort transaction.`;
  } else if (possibleWashTrading) {
    actionAdvice = `SUSPECTED WASH TRADING. Momentum zeroed out due to artificial volume or high avg trade size relative to liquidity.`;
  } else if (riskLevel === 'CRITICAL') {
    actionAdvice = `CRITICAL RISK (${security.warnings.join('; ')}). Abort transaction.`;
  } else if (alphaScore !== null && alphaScore > 75 && momentumScore > 70) {
    actionAdvice = `STRONG MOMENTUM SIGNAL. Verified contract, pool age ${poolAgeHours}h, buy ratio is ${buyRatio1h.toFixed(1)}x.`;
  } else if (momentumScore < 45) {
    actionAdvice = `MONITOR / PASS. Contract safe, but selling pressure or weak momentum detected (${buys1h} buys vs ${sells1h} sells in 1h).`;
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
      poolAgeDiscountApplied,
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
        security: 0.40,
        momentum: 0.35,
        liquidity: 0.25,
      },
      vetoConditions: [
        'auditStatus !== VERIFIED -> alphaScore = null',
        'isHoneypot === true -> alphaScore = 0',
        'ownerCanChangeBalance === true -> alphaScore = 0',
        'possibleWashTrading === true -> momentumScore = 0 (No points awarded)',
        'poolAgeHours < 24 -> momentum discounted linearly by (poolAgeHours / 24)',
      ],
    },
    agentActionableSummary: actionAdvice,
    timestamp: new Date().toISOString(),
  };
}
