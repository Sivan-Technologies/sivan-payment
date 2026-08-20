import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { SOLANA_USDC_MINTS } from '../src/wallets/solana/spl-transfer.js';

const FEE_WALLET = 'Faj6u5v1phTw1zwsKUPiqB82idj3wdn8JCSm3Un4KFEu';
const DEVNET_RPC = 'https://api.devnet.solana.com';

async function main() {
  console.log(`--- Checking Fee Wallet Devnet Status ---`);
  console.log(`Fee Wallet Address: ${FEE_WALLET}`);

  const connection = new Connection(DEVNET_RPC, 'confirmed');
  const walletPubkey = new PublicKey(FEE_WALLET);

  // 1. SOL Balance
  const solLamports = await connection.getBalance(walletPubkey).catch(() => 0);
  console.log(`SOL Balance: ${solLamports / 1e9} SOL`);

  // 2. Devnet USDC Token Balance
  const usdcMint = new PublicKey(SOLANA_USDC_MINTS.devnet);
  const ata = await getAssociatedTokenAddress(usdcMint, walletPubkey).catch(() => null);

  if (ata) {
    console.log(`USDC Associated Token Address (ATA): ${ata.toBase58()}`);
    const tokenBal = await connection.getTokenAccountBalance(ata).catch(() => null);
    if (tokenBal && tokenBal.value) {
      console.log(`Devnet USDC Fee Balance: ${tokenBal.value.uiAmountString} USDC`);
    } else {
      console.log(`Devnet USDC Fee Balance: 0.00 USDC (ATA not created yet or empty)`);
    }
  }

  // 3. Recent Transaction History
  const signatures = await connection.getSignaturesForAddress(walletPubkey, { limit: 10 }).catch(() => []);
  console.log(`\nRecent Devnet Transactions (${signatures.length}):`);
  for (const s of signatures) {
    console.log(`- Signature: ${s.signature} | Slot: ${s.slot} | Err: ${s.err ? JSON.stringify(s.err) : 'none'}`);
  }
}

main().catch(console.error);
