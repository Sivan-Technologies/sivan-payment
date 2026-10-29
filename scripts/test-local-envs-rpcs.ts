interface RpcTarget {
  name: string;
  url: string;
  type: 'evm' | 'solana' | 'stellar' | 'http';
}

const rpcs: RpcTarget[] = [
  { name: 'ARC_RPC_URL (Mainnet)', url: 'https://rpc.mainnet.arc.io', type: 'evm' },
  { name: 'ARC_RPC_FALLBACK_URL (Mainnet)', url: 'https://rpc.arc-scan.org', type: 'evm' },
  { name: 'ARC_RPC_URL (Testnet Network)', url: 'https://rpc.testnet.arc.network', type: 'evm' },
  { name: 'ARC_RPC_FALLBACK_URL (Testnet IO)', url: 'https://rpc.testnet.arc.io', type: 'evm' },
  { name: 'CELO_RPC_URL (Chainstack)', url: 'https://celo-mainnet.core.chainstack.com/0d9b9b94193030eccd772822ba1aa678', type: 'evm' },
  { name: 'CELO_RPC_FALLBACK_URL (Forno)', url: 'https://forno.celo.org', type: 'evm' },
  { name: 'BASE_RPC_URL', url: 'https://mainnet.base.org', type: 'evm' },
  { name: 'BASE_RPC_FALLBACK_URL', url: 'https://base-rpc.publicnode.com', type: 'evm' },
  { name: 'BSC_RPC_URL', url: 'https://bsc-dataseed.binance.org', type: 'evm' },
  { name: 'BSC_RPC_FALLBACK_URL', url: 'https://binance.llamarpc.com', type: 'evm' },
  { name: 'SOLANA_RPC_URL (Chainstack)', url: 'https://solana-mainnet.core.chainstack.com/4a89991bc814e7259c463a15a4408c6a', type: 'solana' },
  { name: 'SOLANA_RPC_FALLBACK_URL', url: 'https://api.mainnet-beta.solana.com', type: 'solana' },
  { name: 'ARBITRUM_RPC_URL', url: 'https://arb1.arbitrum.io/rpc', type: 'evm' },
  { name: 'ARBITRUM_RPC_FALLBACK_URL', url: 'https://arbitrum.drpc.org', type: 'evm' },
  { name: 'STELLAR_HORIZON_URL', url: 'https://horizon.stellar.org/fee_stats', type: 'stellar' },
  { name: 'SYNAPSE_RPC_URL', url: 'https://staging.oobeprotocol.ai:8080/rpc?', type: 'http' }
];

async function testAll() {
  console.log('Testing all RPC Endpoints from .local-server-envs...\n');
  let passed = 0;
  let failed = 0;

  for (const rpc of rpcs) {
    const start = Date.now();
    try {
      if (rpc.type === 'evm') {
        const res = await fetch(rpc.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
          signal: AbortSignal.timeout(8000)
        });
        const json = (await res.json()) as any;
        const duration = Date.now() - start;
        if (json?.result) {
          const decimalChainId = parseInt(json.result, 16);
          console.log(`[PASS] ${rpc.name.padEnd(35)} | ChainId: ${decimalChainId} (${json.result}) | Latency: ${duration}ms`);
          passed++;
        } else {
          console.log(`[FAIL] ${rpc.name.padEnd(35)} | Response: ${JSON.stringify(json)} | Latency: ${duration}ms`);
          failed++;
        }
      } else if (rpc.type === 'solana') {
        const res = await fetch(rpc.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }),
          signal: AbortSignal.timeout(8000)
        });
        const json = (await res.json()) as any;
        const duration = Date.now() - start;
        if (json?.result) {
          console.log(`[PASS] ${rpc.name.padEnd(35)} | Slot: ${json.result} | Latency: ${duration}ms`);
          passed++;
        } else {
          console.log(`[FAIL] ${rpc.name.padEnd(35)} | Response: ${JSON.stringify(json)} | Latency: ${duration}ms`);
          failed++;
        }
      } else if (rpc.type === 'stellar') {
        const res = await fetch(rpc.url, { signal: AbortSignal.timeout(8000) });
        const json = (await res.json()) as any;
        const duration = Date.now() - start;
        if (json?.min_accepted_fee !== undefined || json?.fee_charged) {
          console.log(`[PASS] ${rpc.name.padEnd(35)} | Horizon Fee: ${json.min_accepted_fee || json?.fee_charged?.mode} stroops | Latency: ${duration}ms`);
          passed++;
        } else {
          console.log(`[FAIL] ${rpc.name.padEnd(35)} | Response: ${JSON.stringify(json)} | Latency: ${duration}ms`);
          failed++;
        }
      } else if (rpc.type === 'http') {
        const res = await fetch(rpc.url, { signal: AbortSignal.timeout(8000) });
        const duration = Date.now() - start;
        console.log(`[INFO] ${rpc.name.padEnd(35)} | Status: ${res.status} ${res.statusText} | Latency: ${duration}ms`);
        if (res.status < 500) {
          passed++;
        } else {
          failed++;
        }
      }
    } catch (err: any) {
      const duration = Date.now() - start;
      console.log(`[FAIL] ${rpc.name.padEnd(35)} | Error: ${err.message} | Latency: ${duration}ms`);
      failed++;
    }
  }

  console.log(`\n========================================`);
  console.log(`RPC Summary: ${passed} ONLINE / WORKING | ${failed} FAILING`);
  console.log(`========================================\n`);
}

testAll();
