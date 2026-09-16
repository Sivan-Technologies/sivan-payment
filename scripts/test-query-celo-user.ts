export {};

const addresses = [
  '0xC8cAA84402b1397A055b0c2F388a510f58786285',
  '0x901255F561BCf73688fa1b1c18a9cA836132d132',
  '0xf8ADBdf6089Ef58160a110e6fcE1B9A44E9A0f88',
];

const mainnetRpc = 'https://forno.celo.org';

const tokens = {
  USDC_MAINNET: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
  CUSD_MAINNET: '0x765DE816845861e75A25fCA122bb6898B8B1282a',
  USDT_MAINNET: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e',
};

async function rpcCall(method: string, params: any[]) {
  const res = await fetch(mainnetRpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data: any = await res.json();
  return data.result;
}

async function getErc20Balance(tokenAddress: string, owner: string, decimals: number) {
  const cleanAddr = owner.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const data = `0x70a08231${cleanAddr}`;
  const res = await rpcCall('eth_call', [{ to: tokenAddress, data }, 'latest']);
  if (!res || res === '0x') return '0';
  const raw = BigInt(res);
  return (Number(raw) / (10 ** decimals)).toFixed(6);
}

async function main() {
  for (const addr of addresses) {
    console.log(`\nAddress: ${addr}`);
    const nativeHex = await rpcCall('eth_getBalance', [addr, 'latest']);
    const nativeCelo = Number(BigInt(nativeHex || '0x0')) / 1e18;
    console.log('  Native CELO:', nativeCelo);
    const usdc = await getErc20Balance(tokens.USDC_MAINNET, addr, 6);
    console.log('  USDC (Mainnet):', usdc);
    const cusd = await getErc20Balance(tokens.CUSD_MAINNET, addr, 18);
    console.log('  cUSD (Mainnet):', cusd);
  }
}

main().catch(console.error);
