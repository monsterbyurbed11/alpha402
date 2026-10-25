/**
 * Simulated AI Agent Client
 * Demonstrates how an AI Agent handles the HTTP 402 cycle:
 * 1. Request -> 402 Payment Required
 * 2. Parses challenge -> Pays micro-invoice from agent wallet
 * 3. Re-requests with Authorization proof -> Receives Alpha Signal
 */

const API_BASE = process.env.API_BASE || 'http://localhost:8402';
// Test token: BRETT on Base (0x532f27101965dd16442e59d40670faf5ebb142e4)
const TEST_TOKEN = '0x532f27101965dd16442e59d40670faf5ebb142e4';
const NETWORK = 'base';

async function runAgent() {
  console.log(`\n🤖 [AI Agent] Initializing on-chain alpha inquiry...`);
  console.log(`🎯 Target Token: ${TEST_TOKEN} on ${NETWORK}\n`);

  const endpoint = `${API_BASE}/v1/token-alpha?network=${NETWORK}&address=${TEST_TOKEN}`;

  // STEP 1: First attempt without payment
  console.log(`📡 [Step 1] Agent calling API: GET ${endpoint}`);
  let response = await fetch(endpoint);

  console.log(`📥 [Response] Status: ${response.status} ${response.statusText}`);

  if (response.status === 402) {
    const challengeData: any = await response.json();
    const wwwAuth = response.headers.get('WWW-Authenticate');

    console.log(`\n💳 [HTTP 402 Caught] Payment Required!`);
    console.log(`   Headers: WWW-Authenticate: ${wwwAuth}`);
    console.log(`   Price: $${challengeData.pricing.costUsdc} USDC (${challengeData.pricing.costSats} sats)`);
    console.log(`   Token Challenge ID: ${challengeData.paymentOptions.l402.token}`);

    // STEP 2: Agent wallet executes micro-settlement
    console.log(`\n⚡ [Step 2] Agent wallet executing automated micro-settlement...`);
    const challengeToken = challengeData.paymentOptions.l402.token;
    // In production with real Lightning, agent uses WebLN / Alby / AgentKit to pay the invoice and receive preimage
    const simulatedPreimage = 'TEST_PREIMAGE_OK';
    const authHeader = `L402 ${challengeToken}:${simulatedPreimage}`;

    console.log(`✅ [Payment Successful] Generated Auth Header: "${authHeader}"`);

    // STEP 3: Agent retries request with proof of payment
    console.log(`\n📡 [Step 3] Re-requesting with payment authorization...`);
    response = await fetch(endpoint, {
      headers: {
        Authorization: authHeader,
      },
    });

    console.log(`📥 [Response] Status: ${response.status} ${response.statusText}`);
  }

  if (response.ok) {
    const data: any = await response.json();
    console.log(`\n🎉 [Success] Alpha Signal Received! Verified by: ${data.paymentVerifiedBy}`);
    console.log(`------------------------------------------------------`);
    console.log(`Token:               ${data.data.token.name} (${data.data.token.symbol})`);
    console.log(`Alpha Score:         ${data.data.alphaScore} / 100`);
    console.log(`Risk Level:          ${data.data.riskLevel}`);
    console.log(`Momentum Score:      ${data.data.signals.momentumScore} / 100`);
    console.log(`Security Score:      ${data.data.signals.securityScore} / 100`);
    console.log(`Liquidity Score:     ${data.data.signals.liquidityScore} / 100`);
    console.log(`1h Buy/Sell Ratio:   ${data.data.signals.buyPressureRatio1h}x`);
    console.log(`Is Honeypot:         ${data.data.securityAudit.isHoneypot ? 'YES ⚠️' : 'NO ✅'}`);
    console.log(`Buy / Sell Tax:      ${data.data.securityAudit.buyTax} / ${data.data.securityAudit.sellTax}`);
    console.log(`Price USD:           $${data.data.marketSummary.priceUsd}`);
    console.log(`Liquidity USD:       $${data.data.marketSummary.liquidityUsd.toLocaleString()}`);
    console.log(`------------------------------------------------------`);
    console.log(`🧠 [LLM Decision Prompt]:`);
    console.log(`"${data.data.agentActionableSummary}"\n`);
  } else {
    console.error(`❌ Request failed:`, await response.text());
  }
}

runAgent().catch(console.error);
