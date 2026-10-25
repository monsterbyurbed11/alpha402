import { DexPairData } from '../types.js';

export async function fetchDexData(tokenAddress: string, preferredChain?: string): Promise<DexPairData | null> {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Alpha402-Agent-Gateway/1.0'
      }
    });

    if (!res.ok) {
      console.error(`DexScreener API error: ${res.statusText}`);
      return null;
    }

    const data: any = await res.json();
    if (!data.pairs || data.pairs.length === 0) {
      return null;
    }

    // Filter by preferred chain if provided, or pick the pair with the deepest liquidity
    let filteredPairs = data.pairs;
    if (preferredChain) {
      const match = data.pairs.filter((p: any) => p.chainId.toLowerCase() === preferredChain.toLowerCase());
      if (match.length > 0) filteredPairs = match;
    }

    // Sort by liquidity USD descending
    filteredPairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const pair = filteredPairs[0];

    return {
      pairAddress: pair.pairAddress,
      baseToken: {
        address: pair.baseToken.address,
        name: pair.baseToken.name,
        symbol: pair.baseToken.symbol,
      },
      priceUsd: parseFloat(pair.priceUsd || '0'),
      priceChange: {
        m5: pair.priceChange?.m5 || 0,
        h1: pair.priceChange?.h1 || 0,
        h6: pair.priceChange?.h6 || 0,
        h24: pair.priceChange?.h24 || 0,
      },
      volume: {
        m5: pair.volume?.m5 || 0,
        h1: pair.volume?.h1 || 0,
        h24: pair.volume?.h24 || 0,
      },
      txns: {
        m5: { buys: pair.txns?.m5?.buys || 0, sells: pair.txns?.m5?.sells || 0 },
        h1: { buys: pair.txns?.h1?.buys || 0, sells: pair.txns?.h1?.sells || 0 },
        h24: { buys: pair.txns?.h24?.buys || 0, sells: pair.txns?.h24?.sells || 0 },
      },
      liquidityUsd: pair.liquidity?.usd || 0,
      fdv: pair.fdv || 0,
      pairCreatedAt: pair.pairCreatedAt || undefined,
      url: pair.url || `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`,
    };
  } catch (error) {
    console.error('Failed to fetch from DexScreener:', error);
    return null;
  }
}
