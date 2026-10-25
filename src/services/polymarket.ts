import { PolymarketOpportunity } from '../types.js';

export async function fetchPolymarketAlpha(): Promise<PolymarketOpportunity[]> {
  try {
    const url = 'https://gamma-api.polymarket.com/markets?closed=false&limit=10&order=volume24hr&ascending=false';
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Alpha402-Prediction-Scanner/1.0'
      }
    });

    if (!res.ok) {
      console.error(`Polymarket API returned status: ${res.status}`);
      return [];
    }

    const data: any = await res.json();
    if (!Array.isArray(data)) return [];

    return data.map((item: any) => {
      let outcomePrices: { outcome: string; price: number }[] = [];
      try {
        const outcomes = typeof item.outcomes === 'string' ? JSON.parse(item.outcomes) : (item.outcomes || []);
        const prices = typeof item.outcomePrices === 'string' ? JSON.parse(item.outcomePrices) : (item.outcomePrices || []);
        outcomePrices = outcomes.map((name: string, i: number) => ({
          outcome: name,
          price: parseFloat(prices[i] || '0')
        }));
      } catch (e) {
        outcomePrices = [{ outcome: 'Yes', price: 0.5 }, { outcome: 'No', price: 0.5 }];
      }

      // Calculate spread between outcomes if binary
      let spread = 0;
      if (outcomePrices.length === 2) {
        spread = Math.abs(outcomePrices[0].price - (1 - outcomePrices[1].price));
      }

      return {
        id: item.id || item.conditionId || '',
        question: item.question || item.description || 'Unknown Question',
        category: item.category || 'General',
        volumeUsd: parseFloat(item.volume24hr || item.volume || '0'),
        liquidityUsd: parseFloat(item.liquidity || '0'),
        outcomePrices,
        spread: parseFloat(spread.toFixed(4)),
        resolutionDate: item.endDate || item.endDateIso || 'N/A',
        url: `https://polymarket.com/event/${item.slug || item.id}`
      };
    });
  } catch (error) {
    console.error('Failed to fetch from Polymarket:', error);
    return [];
  }
}
