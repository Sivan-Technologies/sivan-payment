const testEndpoints = [
  'https://celo-alfajores.drpc.org',
  'https://celo-alfajores.blockpi.network/v1/rpc/public',
  'https://alfajores-rpc.celo.org',
  'https://celo-alfajores-testnet.public.blastapi.io',
  'https://rpc.ankr.com/celo_alfajores',
  'https://forno.celo.org',
];

async function checkEndpoint(url: string) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    });
    const data: any = await res.json();
    console.log(`✅ ${url} -> Block Hex: ${data.result} (Decimal: ${parseInt(data.result, 16)})`);
  } catch (err: any) {
    console.log(`❌ ${url} -> Failed:`, err.message);
  }
}

async function main() {
  for (const url of testEndpoints) {
    await checkEndpoint(url);
  }
}

main();
