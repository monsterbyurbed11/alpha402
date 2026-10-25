import { DexPairData, SecurityReport, TokenAlphaSignal, Network } from '../types.js';

export function computeAlphaSignal(
  network: Network,
  dexData: DexPairData,
  security: SecurityReport
): TokenAlphaSignal {
  // 1. Security Score (0 - 100)
  let securityScore = 100;
  if (security.isHoneypot) securityScore = 0;
  else if (security.ownerCanChangeBalance) securityScore = 5;
  else {
    securityScore -= security.riskCount * 8;
    if (!security.isOpenSource) securityScore -= 20;
    if (security.buyTax > 5) securityScore -= (security.buyTax - 5) * 2;
    if (security.sellTax > 5) securityScore -= (security.sellTax - 5) * 3;
    if (security.isMintable) securityScore -= 10;
  }
  securityScore = Math.max(0, Math.min(100, Math.round(securityScore)));

  // 2. Liquidity Score (0 - 100)
  // Scaling: < $10k = poor (0-20), $50k = 50, $250k = 80, > $1M = 100
  let liquidityScore = 0;
  const liq = dexData.liquidityUsd;
  if (liq < 10000) liquidityScore = Math.round((liq / 10000) * 20);
  else if (liq < 50000) liquidityScore = 20 + Math.round(((liq - 10000) / 40000) * 30);
  else if (liq < 250000) liquidityScore = 50 + Math.round(((liq - 50000) / 200000) * 30);
  else if (liq < 1000000) liquidityScore = 80 + Math.round(((liq - 250000) / 750000) * 20);
  else liquidityScore = 100;

  // 3. Momentum Score (0 - 100)
  // Combines 1h price change, 5m volume spike, and buy/sell ratio
  const buys1h = dexData.txns.h1.buys;
  const sells1h = dexData.txns.h1.sells;
  const totalTx1h = buys1h + sells1h;
  const buyRatio1h = totalTx1h > 0 ? buys1h / Math.max(1, sells1h) : 1;

  // 5m volume annualized vs 1h average (5m * 12 compared to 1h)
  const vol5mExpected = dexData.volume.h1 / 12;
  const volumeSpikeMultiplier = vol5mExpected > 0 ? dexData.volume.m5 / vol5mExpected : 1;

  let momentumScore = 50;
  if (dexData.priceChange.h1 > 0) {
    momentumScore += Math.min(25, dexData.priceChange.h1 * 0.8);
  } else {
    momentumScore -= Math.min(30, Math.abs(dexData.priceChange.h1) * 0.9);
  }

  if (buyRatio1h > 1.5) momentumScore += 15;
  else if (buyRatio1h < 0.6) momentumScore -= 15;

  if (volumeSpikeMultiplier > 2.0) momentumScore += 10;
  momentumScore = Math.max(0, Math.min(100, Math.round(momentumScore)));

  // 4. Overall Alpha Score (Weighted: 40% Security, 35% Momentum, 25% Liquidity)
  let alphaScore = Math.round((securityScore * 0.40) + (momentumScore * 0.35) + (liquidityScore * 0.25));

  // Hard penalty for unverified / dangerous contracts
  if (security.isHoneypot || security.ownerCanChangeBalance) {
    alphaScore = 0;
  }

  // 5. Determine Risk Level
  let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW';
  if (securityScore < 30 || security.isHoneypot) riskLevel = 'CRITICAL';
  else if (securityScore < 60 || liquidityScore < 30) riskLevel = 'HIGH';
  else if (securityScore < 80 || momentumScore < 40) riskLevel = 'MEDIUM';

  // 6. Generate Agent Actionable Summary (High-density prompt for LLM)
  let actionAdvice = '';
  if (riskLevel === 'CRITICAL') {
    actionAdvice = `REJECT / ABORT. Critical security risk (${security.warnings.join('; ')}).`;
  } else if (riskLevel === 'HIGH') {
    actionAdvice = `HIGH RISK. Weak liquidity ($${Math.round(liq).toLocaleString()}) or contract warnings. Only consider micro-positions.`;
  } else if (alphaScore > 75 && momentumScore > 70) {
    actionAdvice = `STRONG MOMENTUM SIGNAL. Buy ratio is ${buyRatio1h.toFixed(1)}x with clean security audit. 1h price trend is +${dexData.priceChange.h1}%.`;
  } else if (momentumScore < 45) {
    actionAdvice = `MONITOR / PASS. Contract is safe, but bearish selling pressure detected (${buys1h} buys vs ${sells1h} sells in 1h).`;
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
      isHoneypot: security.isHoneypot,
      buyTax: `${security.buyTax.toFixed(1)}%`,
      sellTax: `${security.sellTax.toFixed(1)}%`,
      isOpenSource: security.isOpenSource,
      warnings: security.warnings,
    },
    agentActionableSummary: actionAdvice,
    timestamp: new Date().toISOString(),
  };
}
