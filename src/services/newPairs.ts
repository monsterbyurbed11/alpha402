import { Network, TokenAlphaSignal, isValidNetwork, isValidTokenAddress } from '../types.js';
import { fetchDexData } from './dexscreener.js';
import { fetchSecurityReport } from './goplus.js';
import { computeAlphaSignal } from './alphaEngine.js';

// Fallback high-activity canonical tokens per chain if DexScreener token-profiles/boosts returns sparse results for a chain
const SEED_TOKENS_BY_CHAIN: Record<Network, string[]> = {
  base: [
    '0x532f27101965dd16442e59d40670faf5ebb142e4', // BRETT
    '0x4ed4e862860bed51a9570b96d89af5e1b0efefed', // DEGEN
    '0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4', // TOSHI
  ],
  solana: [
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
  ],
  ethereum: [
    '0x6982508145454ce325ddbe47a25d4ec3d2311933', // PEPE
    '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce', // SHIB
  ],
  bsc: [
    '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82', // CAKE
  ],
  arbitrum: [
    '0x912ce59144191c1204e64559fe8253a0e49e6548', // ARB
  ],
  polygon: [
    '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', // WPOL
  ],
};

export interface NewPairsFeedResult {
  network: Network;
  scannedCount: number;
  verifiedSafeCount: number;
  pairs: TokenAlphaSignal[];
  timestamp: string;
}

/**
 * Discovers newly active and boosted token pairs on the target chain via DexScreener,
 * performs concurrent GoPlus security audits on each candidate,
 * strictly filters out honeypots and unverified audits (fail-closed),
 * and ranks safe pairs by composite AlphaScore descending.
 */
export async function fetchNewPairsAlpha(
  network: Network = 'base',
  limit = 5
): Promise<NewPairsFeedResult | null> {
  if (!isValidNetwork(network)) {
    return null;
  }

  const clampedLimit = Math.max(1, Math.min(10, limit));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  const candidateAddresses = new Set<string>();

  try {
    const [profilesRes, boostsRes] = await Promise.allSettled([
      fetch('https://api.dexscreener.com/token-profiles/latest/v1', {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'Alpha402-NewPairs-Scanner/1.5' },
      }),
      fetch('https://api.dexscreener.com/token-boosts/latest/v1', {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'Alpha402-NewPairs-Scanner/1.5' },
      }),
    ]);

    for (const settled of [profilesRes, boostsRes]) {
      if (settled.status === 'fulfilled' && settled.value.ok) {
        const items: any = await settled.value.json();
        if (Array.isArray(items)) {
          for (const item of items) {
            if (
              item?.chainId?.toLowerCase() === network &&
              typeof item?.tokenAddress === 'string' &&
              isValidTokenAddress(network, item.tokenAddress)
            ) {
              candidateAddresses.add(
                network === 'solana' ? item.tokenAddress.trim() : item.tokenAddress.trim().toLowerCase()
              );
              if (candidateAddresses.size >= clampedLimit * 2) break;
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('Error fetching DexScreener discovery feeds:', err);
  } finally {
    clearTimeout(timeout);
  }

  // Supplement with active chain seeds if live feed had fewer candidates for the requested chain
  for (const seed of SEED_TOKENS_BY_CHAIN[network] || []) {
    if (candidateAddresses.size >= clampedLimit) break;
    candidateAddresses.add(network === 'solana' ? seed : seed.toLowerCase());
  }

  const targets = Array.from(candidateAddresses).slice(0, clampedLimit * 2);
  if (targets.length === 0) {
    return null;
  }

  const evaluations = await Promise.all(
    targets.map(async (addr) => {
      const [dexData, security] = await Promise.all([
        fetchDexData(addr, network),
        fetchSecurityReport(network, addr),
      ]);
      if (!dexData) return null;
      // Fail-closed: only include pairs whose contract audit succeeded and are NOT honeypots or balance-modifiable
      if (
        security.auditStatus !== 'VERIFIED' ||
        security.isHoneypot !== false ||
        security.ownerCanChangeBalance
      ) {
        return null;
      }
      return computeAlphaSignal(network, dexData, security);
    })
  );

  const validSignals = evaluations
    .filter((item): item is TokenAlphaSignal => item !== null && item.alphaScore !== null)
    .sort((a, b) => (b.alphaScore ?? 0) - (a.alphaScore ?? 0))
    .slice(0, clampedLimit);

  return {
    network,
    scannedCount: targets.length,
    verifiedSafeCount: validSignals.length,
    pairs: validSignals,
    timestamp: new Date().toISOString(),
  };
}
