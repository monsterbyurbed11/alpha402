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

    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Alpha402-Security-Scanner/1.0'
      }
    });

    if (!res.ok) {
      warnings.push(`Security check service returned ${res.status}`);
      return createFallbackReport(warnings);
    }

    const data: any = await res.json();
    const resultObj = data.result || {};
    const details = resultObj[tokenAddress.toLowerCase()] || resultObj[tokenAddress] || {};

    if (!details || Object.keys(details).length === 0) {
      warnings.push('No audit records found on GoPlus security index.');
      return createFallbackReport(warnings);
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
    warnings.push(`Security check error: ${err.message}`);
    return createFallbackReport(warnings);
  }
}

function createFallbackReport(warnings: string[]): SecurityReport {
  return {
    isHoneypot: false,
    buyTax: 0,
    sellTax: 0,
    isOpenSource: true,
    cannotSellAll: false,
    ownerCanChangeBalance: false,
    isMintable: false,
    isBlacklisted: false,
    creatorPercent: 0,
    topHoldersPercent: 0,
    riskCount: 1,
    warnings,
  };
}
