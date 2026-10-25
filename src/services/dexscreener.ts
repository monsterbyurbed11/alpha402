import { DexPairData, isValidNetwork, isValidTokenAddress } from '../types.js';

function safeFloat(val: unknown, fallback = 0): number {
  const num = typeof val === 'number' ? val : parseFloat(String(val ?? '0'));
  return Number.isFinite(num) ? num : fallback;
}

export async function fetchDexData(tokenAddress: string, preferredChain?: string): Promise<DexPairData | null> {
  if (!tokenAddress || typeof tokenAddress !== 'string') {
    return null;
  }

  const cleanAddress = tokenAddress.trim();
  if (preferredChain && isValidNetwork(preferredChain.toLowerCase())) {
    if (!isValidTokenAddress(preferredChain.toLowerCase() as any, cleanAddress)) {
      return null;
    }
  } else if (!/^[a-zA-Z0-9]{20,64}$/.test(cleanAddress)) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(cleanAddress)}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Alpha402-Agent-Gateway/1.4',
      },
    });

    if (!res.ok) {
      console.error(`DexScreener API error: ${res.status} ${res.statusText}`);
      return null;
    }

    const data: any = await res.json();
    if (!data || !Array.isArray(data.pairs) || data.pairs.length === 0) {
      return null;
    }

    let filteredPairs = data.pairs;

    // Strictly filter by preferredChain if provided so we never return a pool from the wrong network
    if (preferredChain) {
      const targetChain = preferredChain.toLowerCase();
      filteredPairs = filteredPairs.filter((p: any) => p?.chainId?.toLowerCase() === targetChain);
      if (filteredPairs.length === 0) {
        return null;
      }
    }

    // Prefer pairs where the queried token is the baseToken (not the quoteToken)
    const baseMatchedPairs = filteredPairs.filter(
      (p: any) => p?.baseToken?.address?.toLowerCase() === cleanAddress.toLowerCase()
    );
    if (baseMatchedPairs.length > 0) {
      filteredPairs = baseMatchedPairs;
    }

    // Sort by liquidity USD descending
    filteredPairs.sort((a: any, b: any) => safeFloat(b?.liquidity?.usd) - safeFloat(a?.liquidity?.usd));
    const pair = filteredPairs[0];

    if (!pair || !pair.baseToken) {
      return null;
    }

    return {
      pairAddress: String(pair.pairAddress || ''),
      baseToken: {
        address: String(pair.baseToken.address || cleanAddress),
        name: String(pair.baseToken.name || 'Unknown Token'),
        symbol: String(pair.baseToken.symbol || 'UNKNOWN'),
      },
      priceUsd: safeFloat(pair.priceUsd),
      priceChange: {
        m5: safeFloat(pair.priceChange?.m5),
        h1: safeFloat(pair.priceChange?.h1),
        h6: safeFloat(pair.priceChange?.h6),
        h24: safeFloat(pair.priceChange?.h24),
      },
      volume: {
        m5: safeFloat(pair.volume?.m5),
        h1: safeFloat(pair.volume?.h1),
        h24: safeFloat(pair.volume?.h24),
      },
      txns: {
        m5: {
          buys: Math.max(0, Math.floor(safeFloat(pair.txns?.m5?.buys))),
          sells: Math.max(0, Math.floor(safeFloat(pair.txns?.m5?.sells))),
        },
        h1: {
          buys: Math.max(0, Math.floor(safeFloat(pair.txns?.h1?.buys))),
          sells: Math.max(0, Math.floor(safeFloat(pair.txns?.h1?.sells))),
        },
        h24: {
          buys: Math.max(0, Math.floor(safeFloat(pair.txns?.h24?.buys))),
          sells: Math.max(0, Math.floor(safeFloat(pair.txns?.h24?.sells))),
        },
      },
      liquidityUsd: Math.max(0, safeFloat(pair.liquidity?.usd)),
      fdv: Math.max(0, safeFloat(pair.fdv)),
      pairCreatedAt: typeof pair.pairCreatedAt === 'number' && Number.isFinite(pair.pairCreatedAt) ? pair.pairCreatedAt : undefined,
      url: pair.url || `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`,
    };
  } catch (error) {
    console.error('Failed to fetch from DexScreener:', error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
