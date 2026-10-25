import { SecurityReport, Network } from '../types.js';

const CHAIN_ID_MAP: Record<Network, string> = {
  ethereum: '1',
  base: '8453',
  bsc: '56',
  arbitrum: '42161',
  polygon: '137',
  solana: 'solana'
};

export async function fetchSecurityReport(network: Network, tokenAddress: string): Promise<SecurityReport> {
  const warnings: string[] = [];
  let riskCount = 0;

  try {
    const chainId = CHAIN_ID_MAP[network] || '8453';
    let url = '';

    if (network === 'solana') {
      url = `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${tokenAddress}`;
    } else {
      url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${tokenAddress.toLowerCase()}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000); // 4-second strict timeout

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Alpha402-Security-Scanner/1.0'
      }
    });

    clearTimeout(timeout);

    if (!res.ok) {
      warnings.push(`AUDIT_UNAVAILABLE: Security provider responded with HTTP ${res.status}. Failing closed.`);
      return createFailClosedReport('UNAVAILABLE', warnings);
    }

    const data: any = await res.json();
    const resultObj = data.result || {};
    const details = resultObj[tokenAddress.toLowerCase()] || resultObj[tokenAddress] || {};

    if (!details || Object.keys(details).length === 0) {
      warnings.push('AUDIT_UNAVAILABLE: No audit records found for token. Contract is unindexed.');
      return createFailClosedReport('UNAVAILABLE', warnings);
    }

    const isHoneypot = details.is_honeypot === '1';
    if (isHoneypot) {
      warnings.push('CRITICAL: Token is flagged as a HONEYPOT. Sell is blocked!');
      riskCount += 10;
    }

    const buyTax = parseFloat(details.buy_tax || '0') * 100;
    const sellTax = parseFloat(details.sell_tax || '0') * 100;

    if (buyTax > 10) {
      warnings.push(`High Buy Tax detected: ${buyTax.toFixed(1)}%`);
      riskCount += 2;
    }
    if (sellTax > 10) {
      warnings.push(`High Sell Tax detected: ${sellTax.toFixed(1)}%`);
      riskCount += 3;
    }

    const isOpenSource = details.is_open_source === '1';
    if (!isOpenSource) {
      warnings.push('Contract source code is UNVERIFIED / closed source.');
      riskCount += 2;
    }

    const cannotSellAll = details.cannot_sell_all === '1';
    if (cannotSellAll) {
      warnings.push('Restriction detected: Cannot sell all tokens at once.');
      riskCount += 4;
    }

    const ownerCanChangeBalance = details.owner_change_balance === '1';
    if (ownerCanChangeBalance) {
      warnings.push('CRITICAL: Owner has permission to modify holder balances!');
      riskCount += 8;
    }

    const isMintable = details.is_mintable === '1';
    if (isMintable) {
      warnings.push('Contract has active minting capability (inflation risk).');
      riskCount += 1;
    }

    const isBlacklisted = details.is_blacklisted === '1';
    if (isBlacklisted) {
      warnings.push('Address is present on security blacklist.');
      riskCount += 5;
    }

    const creatorPercent = parseFloat(details.creator_percent || '0') * 100;
    const topHoldersPercent = (details.holders || [])
      .slice(0, 10)
      .reduce((sum: number, h: any) => sum + parseFloat(h.percent || '0'), 0) * 100;

    if (topHoldersPercent > 70) {
      warnings.push(`High concentration: Top 10 holders control ${topHoldersPercent.toFixed(1)}% of supply.`);
      riskCount += 2;
    }

    return {
      auditStatus: 'VERIFIED',
      isHoneypot,
      buyTax,
      sellTax,
      isOpenSource,
      cannotSellAll,
      ownerCanChangeBalance,
      isMintable,
      isBlacklisted,
      creatorPercent,
      topHoldersPercent,
      riskCount,
      warnings,
    };
  } catch (err: any) {
    const isTimeout = err.name === 'AbortError';
    warnings.push(isTimeout ? 'AUDIT_TIMEOUT: Security check timed out after 4s. Failing closed.' : `AUDIT_ERROR: ${err.message}. Failing closed.`);
    return createFailClosedReport(isTimeout ? 'TIMEOUT' : 'ERROR', warnings);
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
    isOpenSource: false,
    cannotSellAll: false,
    ownerCanChangeBalance: false,
    isMintable: false,
    isBlacklisted: false,
    creatorPercent: 0,
    topHoldersPercent: 0,
    riskCount: 8, // Substantial risk penalty for unverified contracts
    warnings,
  };
}
