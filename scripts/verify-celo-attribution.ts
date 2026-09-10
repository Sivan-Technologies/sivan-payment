import { fromDataSuffix, toDataSuffix, SIVAN_CELO_ATTRIBUTION_TAG } from '../src/wallets/celo/celo-tx-builder.js';
import https from 'node:https';

/**
 * Utility to verify Celo on-chain transaction attribution for Hackathon: Agents at Work
 */

const CELO_MAINNET_RPC = 'https://forno.celo.org';

function queryRpc(method: string, params: any[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = https.request(CELO_MAINNET_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

export async function verifyTransactionAttribution(txHash: string) {
  console.log(`\n🔍 Verifying Celo Mainnet transaction: ${txHash}`);
  const rpcRes = await queryRpc('eth_getTransactionByHash', [txHash]);
  const tx = rpcRes?.result;

  if (!tx) {
    console.error('❌ Transaction not found on Celo Mainnet.');
    return;
  }

  console.log(`  From: ${tx.from}`);
  console.log(`  To: ${tx.to}`);
  console.log(`  Block Number: ${parseInt(tx.blockNumber, 16)}`);
  console.log(`  Input Data Length: ${(tx.input?.length - 2) / 2} bytes`);

  const decoded = fromDataSuffix(tx.input);
  if (!decoded) {
    console.log('  ⚠️ No ERC-8021 attribution suffix detected on this transaction.');
    return;
  }

  console.log('  ✅ ERC-8021 Attribution Suffix Detected:');
  console.log(`     Codes: ${decoded.codes.join(', ')}`);
  console.log(`     Schema ID: ${decoded.schemaId}`);

  const hasSivanTag = decoded.codes.includes(SIVAN_CELO_ATTRIBUTION_TAG);
  if (hasSivanTag) {
    console.log(`  🌟 SIVAN AI OFFICIAL TAG VERIFIED: ${SIVAN_CELO_ATTRIBUTION_TAG}`);
    console.log('  This transaction is actively credited on the Celo Agents at Work Dune leaderboard!');
  } else {
    console.log(`  ℹ️ Transaction carries other tags: ${decoded.codes.join(', ')}`);
  }
}

// If run directly with a txHash argument
const argHash = process.argv[2];
if (argHash && argHash.startsWith('0x')) {
  verifyTransactionAttribution(argHash).catch(console.error);
} else {
  console.log('Usage: npx tsx scripts/verify-celo-attribution.ts <0x_CELO_TX_HASH>');
  console.log(`Official Assigned Tag: ${SIVAN_CELO_ATTRIBUTION_TAG}`);
  console.log(`Generated Data Suffix: ${toDataSuffix(SIVAN_CELO_ATTRIBUTION_TAG)}`);
}
