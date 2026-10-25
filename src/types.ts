export type Network = 'base' | 'ethereum' | 'solana' | 'bsc' | 'arbitrum' | 'polygon';

export interface TokenAlphaRequest {
  network: Network;
  address: string;
}

export interface DexPairData {
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceUsd: number;
  priceChange: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  volume: {
    m5: number;
    h1: number;
    h24: number;
  };
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  liquidityUsd: number;
  fdv: number;
  url: string;
}

export interface SecurityReport {
  isHoneypot: boolean;
  buyTax: number;
  sellTax: number;
  isOpenSource: boolean;
  cannotSellAll: boolean;
  ownerCanChangeBalance: boolean;
  isMintable: boolean;
  isBlacklisted: boolean;
  creatorPercent: number;
  topHoldersPercent: number;
  riskCount: number;
  warnings: string[];
}

export interface TokenAlphaSignal {
  token: {
    symbol: string;
    name: string;
    address: string;
    network: string;
  };
  alphaScore: number; // 0 - 100
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  signals: {
    momentumScore: number; // 0 - 100
    securityScore: number; // 0 - 100
    liquidityScore: number; // 0 - 100
    buyPressureRatio1h: number; // e.g. 1.8 (1.8x more buys than sells)
    volumeSpike5mVs1hAvg: number; // multiplier
  };
  marketSummary: {
    priceUsd: number;
    priceChange1h: number;
    priceChange24h: number;
    liquidityUsd: number;
    fdv: number;
    volume24h: number;
  };
  securityAudit: {
    isHoneypot: boolean;
    buyTax: string;
    sellTax: string;
    isOpenSource: boolean;
    warnings: string[];
  };
  agentActionableSummary: string; // Tailored for LLM trading decisions
  timestamp: string;
}

export interface PolymarketOpportunity {
  id: string;
  question: string;
  category: string;
  volumeUsd: number;
  liquidityUsd: number;
  outcomePrices: { outcome: string; price: number }[];
  spread: number;
  resolutionDate: string;
  url: string;
}

export interface PaymentDetails {
  protocol: 'L402' | 'x402';
  costUsdc: number;
  costSats: number;
  invoice?: string;
  token?: string;
  recipientAddress?: string;
}
