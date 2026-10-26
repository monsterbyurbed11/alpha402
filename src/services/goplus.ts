import { SecurityReport, Network, isValidNetwork, isValidTokenAddress } from '../types.js';

const CHAIN_ID_MAP: Record<Network, string> = {
  ethereum: '1',
  base: '8453',
  bsc: '56',
  arbitrum: '42161',
  polygon: '137',
  solana: 'solana',
};

function safeFloat(val: unknown, fallback = 0): number {
  const num = typeof val === 'number' ? val : parseFloat(String(val ?? '0'));
  return Number.isFinite(num) ? num : fallback;
}

/**
 * Secondary EVM Security Auditor (Honeypot.is v2 On-Chain Swap Simulation API)
 * Used automatically when GoPlus rate-limits or blocks Cloudflare Worker egress IPs.
 */
async function fetchHoneypotIsFallback(
  chainId: string,
  cleanAddress: string
): Promise<SecurityReport | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const url = `https://api.honeypot.is/v2/IsHoneypot?address=${encodeURIComponent(cleanAddress)}&chainID=${encodeURIComponent(chainId)}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; Alpha402/1.6)',
      },
    });
    if (!res.ok) return null;

    const data: any = await res.json();
    if (!data || data.simulationSuccess === false || typeof data.honeypotResult?.isHoneypot !== 'boolean') {
      return null;
    }

    const warnings: string[] = [];
    let riskCount = 0;

    const buyTax = parseFloat(safeFloat(data.simulationResult?.buyTax, 0).toFixed(2));
    const sellTax = parseFloat(safeFloat(data.simulationResult?.sellTax, 0).toFixed(2));
    const buyTaxBps = Math.round(buyTax * 100);
    const sellTaxBps = Math.round(sellTax * 100);

    const isHoneypot = Boolean(data.honeypotResult?.isHoneypot) || sellTax >= 99;
    if (isHoneypot) {
      warnings.push('CRITICAL: Token is flagged as a HONEYPOT by swap simulation. Sell is blocked!');
      riskCount += 10;
    }

    if (buyTax > 10) {
      warnings.push(`High Buy Tax detected: ${buyTax}%`);
      riskCount += 2;
    }
    if (sellTax > 10) {
      warnings.push(`High Sell Tax detected: ${sellTax}%`);
      riskCount += 3;
    }

    const isOpenSource = data.contractCode?.openSource !== false;
    if (!isOpenSource) {
      warnings.push('Contract source code is UNVERIFIED / closed source.');
      riskCount += 2;
    }

    const flags: string[] = Array.isArray(data.flags)
      ? data.flags.map((f: any) => (typeof f === 'string' ? f : f?.flag || '')).filter(Boolean)
      : [];
    for (const flag of flags) {
      warnings.push(`Simulation flag: ${flag}`);
      riskCount += 2;
    }

    return {
      auditStatus: 'VERIFIED',
      isHoneypot,
      buyTax,
      sellTax,
      buyTaxBps,
      sellTaxBps,
      isOpenSource,
      cannotSellAll: false,
      ownerCanChangeBalance: false,
      isMintable: false,
      isBlacklisted: false,
      creatorPercent: 0,
      topHoldersPercent: 0,
      riskCount,
      warnings,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Secondary Solana SPL Security Auditor (RugCheck v1 API)
 */
async function fetchSolanaRugCheckFallback(cleanAddress: string): Promise<SecurityReport | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const url = `https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(cleanAddress)}/report/summary`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    if (!data || typeof data !== 'object') return null;

    const warnings: string[] = [];
    let riskCount = 0;
    const risks = Array.isArray(data.risks) ? data.risks : [];

    let isMintable = false;
    let isBlacklisted = false;
    let isHoneypot = false;

    for (const r of risks) {
      const name = String(r?.name || '');
      const level = String(r?.level || '').toLowerCase();
      if (name) {
        warnings.push(`${r.name}: ${r.description || r.value || ''}`.trim());
      }
      if (level === 'danger' || level === 'critical') riskCount += 4;
      else if (level === 'warn') riskCount += 2;

      if (/freeze authority/i.test(name)) isBlacklisted = true;
      if (/mint authority/i.test(name)) isMintable = true;
      if (/honeypot|non.?transferable/i.test(name)) isHoneypot = true;
    }

    const feePct = parseFloat(safeFloat(data.transferFee?.pct, 0).toFixed(2));
    return {
      auditStatus: 'VERIFIED',
      isHoneypot,
      buyTax: 0,
      sellTax: feePct,
      buyTaxBps: 0,
      sellTaxBps: Math.round(feePct * 100),
      isOpenSource: true,
      cannotSellAll: false,
      ownerCanChangeBalance: false,
      isMintable,
      isBlacklisted,
      creatorPercent: 0,
      topHoldersPercent: 0,
      riskCount,
      warnings,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchSecurityReport(network: Network, tokenAddress: string): Promise<SecurityReport> {
  const warnings: string[] = [];
  let riskCount = 0;

  if (!isValidNetwork(network)) {
    warnings.push(`AUDIT_UNAVAILABLE: Unsupported network "${String(network)}". Failing closed.`);
    return createFailClosedReport('UNAVAILABLE', warnings);
  }

  if (!isValidTokenAddress(network, tokenAddress)) {
    warnings.push('AUDIT_UNAVAILABLE: Invalid token contract address format. Failing closed.');
    return createFailClosedReport('UNAVAILABLE', warnings);
  }

  const cleanAddress = tokenAddress.trim();
  const chainId = CHAIN_ID_MAP[network];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);

  try {
    const url =
      network === 'solana'
        ? `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${encodeURIComponent(cleanAddress)}`
        : `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${encodeURIComponent(cleanAddress.toLowerCase())}`;

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    });

    if (res.ok) {
      const data: any = await res.json();
      const resultObj = data?.result || {};
      const details = resultObj[cleanAddress.toLowerCase()] || resultObj[cleanAddress] || null;

      if (details && typeof details === 'object' && Object.keys(details).length > 0) {
        const rawBuyTax = safeFloat(details.buy_tax, 0);
        const rawSellTax = safeFloat(details.sell_tax ?? details.transfer_fee?.current_fee_rate?.fee_rate, 0);
        const buyTax = parseFloat((rawBuyTax * 100).toFixed(2));
        const sellTax = parseFloat((rawSellTax * 100).toFixed(2));
        const buyTaxBps = Math.round(rawBuyTax * 10000);
        const sellTaxBps = Math.round(rawSellTax * 10000);

        const isHoneypot =
          details.is_honeypot === '1' ||
          details.non_transferable === '1' ||
          sellTax >= 99;

        if (isHoneypot) {
          warnings.push('CRITICAL: Token is flagged as a HONEYPOT or non-transferable. Sell is blocked!');
          riskCount += 10;
        }

        if (buyTax > 10) {
          warnings.push(`High Buy Tax detected: ${buyTax}%`);
          riskCount += 2;
        }
        if (sellTax > 10) {
          warnings.push(`High Sell Tax detected: ${sellTax}%`);
          riskCount += 3;
        }

        const isOpenSource =
          network === 'solana'
            ? details.is_open_source !== undefined
              ? details.is_open_source === '1'
              : true
            : details.is_open_source === '1';

        if (!isOpenSource) {
          warnings.push('Contract source code is UNVERIFIED / closed source.');
          riskCount += 2;
        }

        const cannotSellAll = details.cannot_sell_all === '1' || details.closable?.status === '1';
        if (cannotSellAll) {
          warnings.push(
            network === 'solana'
              ? 'Restriction detected: Token account close authority is active.'
              : 'Restriction detected: Cannot sell all tokens at once.'
          );
          riskCount += 4;
        }

        const ownerCanChangeBalance =
          details.owner_change_balance === '1' ||
          details.balance_mutable_authority?.status === '1' ||
          details.selfdestruct === '1';

        if (ownerCanChangeBalance) {
          warnings.push('CRITICAL: Owner/authority has permission to modify holder balances or self-destruct!');
          riskCount += 8;
        }

        const isMintable = details.is_mintable === '1' || details.mintable?.status === '1';
        if (isMintable) {
          warnings.push('Contract has active minting capability (inflation risk).');
          riskCount += 1;
        }

        const isBlacklisted =
          details.is_blacklisted === '1' ||
          details.freezable?.status === '1' ||
          details.transfer_pausable === '1';

        if (isBlacklisted) {
          warnings.push(
            details.freezable?.status === '1'
              ? 'Freeze authority is active (token accounts can be frozen).'
              : 'Blacklist or transfer pause capability is active on contract.'
          );
          riskCount += 5;
        }

        if (details.slippage_modifiable === '1') {
          warnings.push('Owner can dynamically modify buy/sell tax rates.');
          riskCount += 3;
        }

        if (details.hidden_owner === '1' || details.can_take_back_ownership === '1') {
          warnings.push('Contract has hidden owner or ownership reclaim capability.');
          riskCount += 3;
        }

        const creatorPercent = safeFloat(details.creator_percent, 0) * 100;
        const holdersList = Array.isArray(details.holders) ? details.holders : [];
        const topHoldersPercent =
          holdersList
            .slice(0, 10)
            .reduce((sum: number, h: any) => sum + safeFloat(h?.percent, 0), 0) * 100;

        if (topHoldersPercent > 70) {
          warnings.push(`High concentration: Top 10 holders control ${topHoldersPercent.toFixed(1)}% of supply.`);
          riskCount += 2;
        }

        return {
          auditStatus: 'VERIFIED',
          isHoneypot,
          buyTax,
          sellTax,
          buyTaxBps,
          sellTaxBps,
          isOpenSource,
          cannotSellAll,
          ownerCanChangeBalance,
          isMintable,
          isBlacklisted,
          creatorPercent: parseFloat(creatorPercent.toFixed(2)),
          topHoldersPercent: parseFloat(topHoldersPercent.toFixed(2)),
          riskCount,
          warnings,
        };
      }
    }
  } catch {
    // Proceed to secondary on-chain simulation auditor before failing closed
  } finally {
    clearTimeout(timeout);
  }

  // Secondary Verified Auditor Fallback (Honeypot.is for EVM, RugCheck for Solana)
  const fallbackReport =
    network === 'solana'
      ? await fetchSolanaRugCheckFallback(cleanAddress)
      : await fetchHoneypotIsFallback(chainId, cleanAddress);

  if (fallbackReport) {
    return fallbackReport;
  }

  warnings.push('AUDIT_UNAVAILABLE: Primary and secondary security auditors unreachable or contract unindexed. Failing closed.');
  return createFailClosedReport('UNAVAILABLE', warnings);
}

/**
 * Fail-Closed Safe Fallback
 * Never assumes a contract is safe when upstream audit is down or unindexed.
 */
function createFailClosedReport(status: 'UNAVAILABLE' | 'TIMEOUT' | 'ERROR', warnings: string[]): SecurityReport {
  return {
    auditStatus: status,
    isHoneypot: null, // Explicitly NULL (Unknown), NEVER false
    buyTax: 0,
    sellTax: 0,
    buyTaxBps: 0,
    sellTaxBps: 0,
    isOpenSource: false,
    cannotSellAll: false,
    ownerCanChangeBalance: false,
    isMintable: false,
    isBlacklisted: false,
    creatorPercent: 0,
    topHoldersPercent: 0,
    riskCount: 8,
    warnings,
  };
}
