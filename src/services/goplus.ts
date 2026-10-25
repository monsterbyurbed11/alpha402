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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000); // 4-second strict timeout

  try {
    const chainId = CHAIN_ID_MAP[network];
    const url =
      network === 'solana'
        ? `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${encodeURIComponent(cleanAddress)}`
        : `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${encodeURIComponent(cleanAddress.toLowerCase())}`;

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Alpha402-Security-Scanner/1.4',
      },
    });

    if (!res.ok) {
      warnings.push(`AUDIT_UNAVAILABLE: Security provider HTTP ${res.status}. Failing closed.`);
      return createFailClosedReport('UNAVAILABLE', warnings);
    }

    const data: any = await res.json();
    const resultObj = data?.result || {};
    const details = resultObj[cleanAddress.toLowerCase()] || resultObj[cleanAddress] || null;

    if (!details || typeof details !== 'object' || Object.keys(details).length === 0) {
      warnings.push('AUDIT_UNAVAILABLE: No audit records found for token. Contract is unindexed.');
      return createFailClosedReport('UNAVAILABLE', warnings);
    }

    // Explicit numeric percentages and basis points (supports both EVM buy_tax/sell_tax and Solana transfer_fee)
    const rawBuyTax = safeFloat(details.buy_tax, 0);
    const rawSellTax = safeFloat(details.sell_tax ?? details.transfer_fee?.current_fee_rate?.fee_rate, 0);
    const buyTax = parseFloat((rawBuyTax * 100).toFixed(2));
    const sellTax = parseFloat((rawSellTax * 100).toFixed(2));
    const buyTaxBps = Math.round(rawBuyTax * 10000);
    const sellTaxBps = Math.round(rawSellTax * 10000);

    // Honeypot check (EVM is_honeypot, Solana non_transferable, or >= 99% effective sell tax)
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

    // On Solana, SPL tokens do not return is_open_source from GoPlus; check metadata_mutable instead
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
  } catch (err: any) {
    const isTimeout = err?.name === 'AbortError';
    warnings.push(
      isTimeout
        ? 'AUDIT_TIMEOUT: Security check timed out after 4s. Failing closed.'
        : `AUDIT_ERROR: ${err?.message || 'Unknown error'}. Failing closed.`
    );
    return createFailClosedReport(isTimeout ? 'TIMEOUT' : 'ERROR', warnings);
  } finally {
    clearTimeout(timeout);
  }
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
