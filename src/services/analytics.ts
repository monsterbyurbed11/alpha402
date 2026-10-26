import { KVNamespaceLike } from '../types.js';

export interface AnalyticsEvent {
  timestamp: string;
  endpoint: string;
  tool?: string;
  network?: string;
  address?: string;
  outcome: 'FREE_TRIAL' | 'PAID_VERIFIED' | 'PAYWALL_402' | 'PAYMENT_FAILED' | 'REFUNDED_503' | 'DISCOVERY';
  paymentType?: string;
  revenueUsdc?: number;
  clientHint?: string;
}

export interface AnalyticsSnapshot {
  updatedAt: string;
  funnel: {
    discoveryHits: number;
    mcpInitializeCalls: number;
    mcpToolsListCalls: number;
    totalToolAndApiCalls: number;
    freeTrialCallsServed: number;
    paywall402ChallengesIssued: number;
    paidCallsVerified: number;
    paymentVerificationFailures: number;
    failClosedRefunds503: number;
    totalRevenueUsdc: number;
  };
  byTool: Record<string, number>;
  byNetwork: Record<string, number>;
  recentEvents: AnalyticsEvent[];
}

const KV_ANALYTICS_KEY = 'alpha402:analytics:v1';
const MAX_RECENT_EVENTS = 30;

let memoryAnalytics: AnalyticsSnapshot = {
  updatedAt: new Date().toISOString(),
  funnel: {
    discoveryHits: 0,
    mcpInitializeCalls: 0,
    mcpToolsListCalls: 0,
    totalToolAndApiCalls: 0,
    freeTrialCallsServed: 0,
    paywall402ChallengesIssued: 0,
    paidCallsVerified: 0,
    paymentVerificationFailures: 0,
    failClosedRefunds503: 0,
    totalRevenueUsdc: 0,
  },
  byTool: {
    check_token_security: 0,
    get_token_alpha: 0,
    get_new_pairs_alpha: 0,
    get_polymarket_alpha: 0,
    get_credits_and_payment_info: 0,
  },
  byNetwork: {
    base: 0,
    solana: 0,
    ethereum: 0,
    bsc: 0,
    arbitrum: 0,
    polygon: 0,
  },
  recentEvents: [],
};

let hydratedFromKv = false;

async function ensureHydrated(kv?: KVNamespaceLike): Promise<void> {
  if (hydratedFromKv || !kv) return;
  hydratedFromKv = true;
  try {
    const raw = await kv.get(KV_ANALYTICS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AnalyticsSnapshot;
      if (parsed && parsed.funnel) {
        memoryAnalytics = {
          updatedAt: new Date().toISOString(),
          funnel: {
            discoveryHits: (parsed.funnel.discoveryHits || 0) + memoryAnalytics.funnel.discoveryHits,
            mcpInitializeCalls:
              (parsed.funnel.mcpInitializeCalls || 0) + memoryAnalytics.funnel.mcpInitializeCalls,
            mcpToolsListCalls:
              (parsed.funnel.mcpToolsListCalls || 0) + memoryAnalytics.funnel.mcpToolsListCalls,
            totalToolAndApiCalls:
              (parsed.funnel.totalToolAndApiCalls || 0) + memoryAnalytics.funnel.totalToolAndApiCalls,
            freeTrialCallsServed:
              (parsed.funnel.freeTrialCallsServed || 0) + memoryAnalytics.funnel.freeTrialCallsServed,
            paywall402ChallengesIssued:
              (parsed.funnel.paywall402ChallengesIssued || 0) +
              memoryAnalytics.funnel.paywall402ChallengesIssued,
            paidCallsVerified:
              (parsed.funnel.paidCallsVerified || 0) + memoryAnalytics.funnel.paidCallsVerified,
            paymentVerificationFailures:
              (parsed.funnel.paymentVerificationFailures || 0) +
              memoryAnalytics.funnel.paymentVerificationFailures,
            failClosedRefunds503:
              (parsed.funnel.failClosedRefunds503 || 0) + memoryAnalytics.funnel.failClosedRefunds503,
            totalRevenueUsdc: Number(
              ((parsed.funnel.totalRevenueUsdc || 0) + memoryAnalytics.funnel.totalRevenueUsdc).toFixed(6)
            ),
          },
          byTool: { ...parsed.byTool, ...memoryAnalytics.byTool },
          byNetwork: { ...parsed.byNetwork, ...memoryAnalytics.byNetwork },
          recentEvents: [
            ...memoryAnalytics.recentEvents,
            ...(Array.isArray(parsed.recentEvents) ? parsed.recentEvents : []),
          ].slice(0, MAX_RECENT_EVENTS),
        };
      }
    }
  } catch {
    // Ignore KV hydration errors
  }
}

export async function recordAnalyticsEvent(
  event: Omit<AnalyticsEvent, 'timestamp'>,
  kv?: KVNamespaceLike
): Promise<void> {
  await ensureHydrated(kv);

  const now = new Date().toISOString();
  memoryAnalytics.updatedAt = now;

  if (event.outcome === 'DISCOVERY') {
    memoryAnalytics.funnel.discoveryHits += 1;
    if (event.tool === 'mcp:initialize') {
      memoryAnalytics.funnel.mcpInitializeCalls += 1;
    } else if (event.tool === 'mcp:tools/list') {
      memoryAnalytics.funnel.mcpToolsListCalls += 1;
    }
  } else {
    memoryAnalytics.funnel.totalToolAndApiCalls += 1;
  }

  if (event.outcome === 'FREE_TRIAL') {
    memoryAnalytics.funnel.freeTrialCallsServed += 1;
  } else if (event.outcome === 'PAYWALL_402') {
    memoryAnalytics.funnel.paywall402ChallengesIssued += 1;
  } else if (event.outcome === 'PAID_VERIFIED') {
    memoryAnalytics.funnel.paidCallsVerified += 1;
    if (typeof event.revenueUsdc === 'number' && event.revenueUsdc > 0) {
      memoryAnalytics.funnel.totalRevenueUsdc = Number(
        (memoryAnalytics.funnel.totalRevenueUsdc + event.revenueUsdc).toFixed(6)
      );
    }
  } else if (event.outcome === 'PAYMENT_FAILED') {
    memoryAnalytics.funnel.paymentVerificationFailures += 1;
  } else if (event.outcome === 'REFUNDED_503') {
    memoryAnalytics.funnel.failClosedRefunds503 += 1;
    if (typeof event.revenueUsdc === 'number' && event.revenueUsdc > 0) {
      memoryAnalytics.funnel.totalRevenueUsdc = Math.max(
        0,
        Number((memoryAnalytics.funnel.totalRevenueUsdc - event.revenueUsdc).toFixed(6))
      );
    }
  }

  if (event.tool && !event.tool.startsWith('mcp:')) {
    memoryAnalytics.byTool[event.tool] = (memoryAnalytics.byTool[event.tool] || 0) + 1;
  }

  if (event.network) {
    memoryAnalytics.byNetwork[event.network] = (memoryAnalytics.byNetwork[event.network] || 0) + 1;
  }

  if (event.outcome !== 'DISCOVERY' || event.tool === 'mcp:initialize') {
    memoryAnalytics.recentEvents.unshift({
      timestamp: now,
      ...event,
    });
    if (memoryAnalytics.recentEvents.length > MAX_RECENT_EVENTS) {
      memoryAnalytics.recentEvents.length = MAX_RECENT_EVENTS;
    }
  }

  if (kv) {
    try {
      await kv.put(KV_ANALYTICS_KEY, JSON.stringify(memoryAnalytics));
    } catch {
      // Non-blocking KV telemetry write
    }
  }
}

export async function getAnalyticsSnapshot(kv?: KVNamespaceLike): Promise<AnalyticsSnapshot> {
  await ensureHydrated(kv);
  return memoryAnalytics;
}
