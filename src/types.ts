export type Network = 'base' | 'ethereum' | 'solana' | 'bsc' | 'arbitrum' | 'polygon';

export const SUPPORTED_NETWORKS: readonly Network[] = [
  'base',
  'ethereum',
  'solana',
  'bsc',
  'arbitrum',
  'polygon',
] as const;

export function isValidNetwork(network: string): network is Network {
  return (SUPPORTED_NETWORKS as readonly string[]).includes(network);
}

export function isValidTokenAddress(network: Network, address: string): boolean {
  if (!address || typeof address !== 'string') return false;
  const trimmed = address.trim();
  if (network === 'solana') {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed);
  }
  return /^0x[a-fA-F0-9]{40}$/.test(trimmed);
}

export interface AppBindings {
  ENABLE_SANDBOX?: string;
  COST_USDC?: string;
  COST_SATS?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  L402_HMAC_SECRET?: string;
  BASE_RPC_URL?: string;
  BASE_RECIPIENT_ADDRESS?: string;
}

export interface AppVariables {
  paymentType: string;
  paymentProof: string;
  paymentCostUnits?: number;
  creditsRemainingUnits?: number;
  creditsRemainingUsdc?: number;
  callsRemaining?: number;
}

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
  pairCreatedAt?: number; // Epoch timestamp in ms
  url: string;
}

export interface SecurityReport {
  auditStatus: 'VERIFIED' | 'UNAVAILABLE' | 'TIMEOUT' | 'ERROR';
  isHoneypot: boolean | null;
  buyTax: number; // Numeric percentage e.g. 5.0 for 5%
  sellTax: number; // Numeric percentage e.g. 5.0 for 5%
  buyTaxBps: number; // Basis points e.g. 500 for 5%
  sellTaxBps: number; // Basis points e.g. 500 for 5%
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
  alphaScore: number | null; // NULL if audit is unverified/failed, 0 if honeypot or owner balance mod
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  signals: {
    momentumScore: number;
    securityScore: number | null;
    liquidityScore: number;
    buyPressureRatio1h: number;
    volumeSpike5mVs1hAvg: number;
    poolAgeHours: number | null;
    poolAgeDiscountApplied: number; // Float between 0.1 and 1.0 based on pool age
    possibleWashTrading: boolean;
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
    auditStatus: 'VERIFIED' | 'UNAVAILABLE' | 'TIMEOUT' | 'ERROR';
    isHoneypot: boolean | null;
    buyTax: number;
    sellTax: number;
    buyTaxBps: number;
    sellTaxBps: number;
    isOpenSource: boolean;
    warnings: string[];
  };
  scoringMethodology: {
    weights: {
      security: number; // e.g. 0.40
      momentum: number; // e.g. 0.35
      liquidity: number; // e.g. 0.25
    };
    vetoConditions: string[];
  };
  agentActionableSummary: string;
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
