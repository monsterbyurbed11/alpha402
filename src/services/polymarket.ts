import { PolymarketOpportunity } from '../types.js';

function safeFloat(val: unknown, fallback = 0): number {
  const num = typeof val === 'number' ? val : parseFloat(String(val ?? '0'));
  return Number.isFinite(num) ? num : fallback;
}

export async function fetchPolymarketAlpha(): Promise<PolymarketOpportunity[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const url = 'https://gamma-api.polymarket.com/markets?closed=false&limit=10&order=volume24hr&ascending=false';
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Alpha402-Prediction-Scanner/1.4',
      },
    });

    if (!res.ok) {
      console.error(`Polymarket API returned status: ${res.status}`);
      return null;
    }

    const data: any = await res.json();
    if (!Array.isArray(data)) return null;

    return data.map((item: any) => {
      let outcomePrices: { outcome: string; price: number }[] = [];
      try {
        const outcomes = typeof item.outcomes === 'string' ? JSON.parse(item.outcomes) : item.outcomes || [];
        const prices =
          typeof item.outcomePrices === 'string' ? JSON.parse(item.outcomePrices) : item.outcomePrices || [];
        if (Array.isArray(outcomes)) {
          outcomePrices = outcomes.map((name: unknown, i: number) => ({
            outcome: String(name ?? `Outcome ${i + 1}`),
            price: safeFloat(Array.isArray(prices) ? prices[i] : 0, 0),
          }));
        }
      } catch {
        outcomePrices = [
          { outcome: 'Yes', price: 0.5 },
          { outcome: 'No', price: 0.5 },
        ];
      }

      // Calculate spread between outcomes if binary
      let spread = 0;
      if (outcomePrices.length === 2) {
        spread = Math.abs(outcomePrices[0].price - (1 - outcomePrices[1].price));
      }

      return {
        id: String(item.id || item.conditionId || ''),
        question: String(item.question || item.description || 'Unknown Question'),
        category: String(item.category || 'General'),
        volumeUsd: safeFloat(item.volume24hr ?? item.volume, 0),
        liquidityUsd: safeFloat(item.liquidity, 0),
        outcomePrices,
        spread: parseFloat(safeFloat(spread, 0).toFixed(4)),
        resolutionDate: String(item.endDate || item.endDateIso || 'N/A'),
        url: `https://polymarket.com/event/${encodeURIComponent(String(item.slug || item.id || ''))}`,
      };
    });
  } catch (error) {
    console.error('Failed to fetch from Polymarket:', error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
