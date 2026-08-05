import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { accountExists, type SolanaRpcOptions } from './solana-rpc.js';

/**
 * Build an SPL token transfer for Privy to sign.
 *
 * Privy signs and broadcasts an ALREADY BUILT transaction - it does not
 * construct one. So the whole transaction is assembled here, and every detail
 * that can be wrong is a way to lose a user's money.
 *
 * WHY THE BLOCKHASH IS A DUMMY
 *
 * A Solana transaction must carry a recent blockhash, which expires in about
 * 60 seconds. Fetching one, building, signing and broadcasting inside that
 * window is a race, and losing it means an opaque failure.
 *
 * Privy removes the race: their docs say to pass the dummy value
 * `11111111111111111111111111111111` and their API substitutes a fresh
 * blockhash server-side, immediately before broadcast. Verified live - a
 * transaction built this way was accepted, signed and broadcast, failing only
 * at simulation because the wallet was empty.
 */

/** Privy's sentinel. Their API replaces it with a real blockhash. */
export const PRIVY_DUMMY_BLOCKHASH = '11111111111111111111111111111111';

export const SOLANA_USDC_MINTS = {
  mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
} as const;

export const SOLANA_USDT_MINTS = {
  mainnet: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  // Deliberately absent: there is no canonical USDT devnet mint, and inventing
  // one would send test funds to a token that is not USDT.
  devnet: undefined,
} as const;

export function solanaMintFor(asset: string, production: boolean): string | undefined {
  const key = production ? 'mainnet' : 'devnet';
  if (String(asset).toLowerCase() === 'usdc') return SOLANA_USDC_MINTS[key];
  if (String(asset).toLowerCase() === 'usdt') return SOLANA_USDT_MINTS[key];
  return undefined;
}

/**
 * Amount to base units, without floating point.
 *
 * `Number(amount) * 10 ** decimals` is the obvious version and it is wrong:
 * 1.1 * 1e6 is 1100000.0000000001, and once that becomes a BigInt the user
 * moves a different sum than the one they approved.
 */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const trimmed = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Invalid amount: ${amount}`);

  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) {
    throw new Error(`${amount} has more than ${decimals} decimal places.`);
  }
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

export interface BuildSplTransferInput {
  /** The user's Privy wallet address - owner and fee payer. */
  fromOwner: string;
  /** Where the tokens go, e.g. Breet's deposit address. */
  toOwner: string;
  mint: string;
  amount: string;
  decimals?: number;
  production?: boolean;
  rpcOptions?: SolanaRpcOptions;
}

export interface BuiltSplTransfer {
  /** base64 VersionedTransaction, ready for Privy. */
  transactionBase64: string;
  fromTokenAccount: string;
  toTokenAccount: string;
  /** True when the recipient had no token account and one is being created. */
  createsRecipientAccount: boolean;
  /**
   * Rent the SENDER pays to create the recipient's token account, in SOL.
   *
   * Surfaced because it is a real cost the user did not ask for. Roughly
   * 0.00204 SOL, which is small but not nothing, and it is deducted from the
   * sender rather than the amount.
   */
  estimatedRentSol: number;
  instructionCount: number;
}

/** Rent-exempt minimum for a 165-byte SPL token account, in SOL. */
const TOKEN_ACCOUNT_RENT_SOL = 0.00203928;

/**
 * Build the transfer, creating the recipient's token account if needed.
 *
 * THE ASSOCIATED TOKEN ACCOUNT IS THE DANGEROUS PART.
 *
 * SPL tokens do not live at a wallet address. They live in a separate account
 * derived from (owner, mint), and it must exist before it can receive. Three
 * ways to get this wrong:
 *
 *   assume it exists   - the transfer fails, and on some paths the funds are
 *                        stranded rather than returned
 *   always create it   - the instruction fails if the account already exists,
 *                        so every repeat transfer breaks
 *   derive it wrongly  - tokens go to an address nobody can spend from
 *
 * So the account is DERIVED deterministically and its existence CHECKED on
 * chain, which is the one thing Privy cannot answer.
 *
 * transferChecked is used rather than transfer: it takes the mint and decimals
 * and verifies them on chain, so a decimals mistake fails loudly instead of
 * moving a thousand times the intended amount.
 */
export async function buildSplTransfer(input: BuildSplTransferInput): Promise<BuiltSplTransfer> {
  const decimals = input.decimals ?? 6;
  const owner = new PublicKey(input.fromOwner);
  const recipient = new PublicKey(input.toOwner);
  const mint = new PublicKey(input.mint);

  const amount = toBaseUnits(input.amount, decimals);
  if (amount <= 0n) throw new Error('Transfer amount must be greater than zero.');

  // allowOwnerOffCurve = true: an exchange deposit address is often a PDA
  // rather than a normal keypair, and refusing those would reject Breet.
  const fromTokenAccount = getAssociatedTokenAddressSync(mint, owner, true);
  const toTokenAccount = getAssociatedTokenAddressSync(mint, recipient, true);

  // `production` MUST reach the RPC layer. Without this the ATA check ran
  // against whichever network APP_ENV implied while the transaction was built
  // for `input.production` - so a mainnet transfer was validated against
  // devnet, reporting "this wallet holds no USDC" for an account that plainly
  // holds it. Silent, and wrong in the direction that blocks real payouts.
  const rpcOptions: SolanaRpcOptions = {
    production: input.production,
    ...(input.rpcOptions ?? {}),
  };

  const [fromExists, toExists] = await Promise.all([
    accountExists(fromTokenAccount.toBase58(), rpcOptions),
    accountExists(toTokenAccount.toBase58(), rpcOptions),
  ]);

  if (!fromExists) {
    // The sender has never held this token. Refused early with a plain
    // message rather than letting simulation fail with "found no record of a
    // prior credit", which tells the user nothing.
    throw new Error(
      `This wallet holds no ${input.mint === SOLANA_USDC_MINTS.mainnet ? 'USDC' : 'token'} on Solana.`
    );
  }

  const instructions = [];

  if (!toExists) {
    // Created by the SENDER, who also pays the rent. Idempotent by omission:
    // this instruction is only added when the account is genuinely absent,
    // because including it for an existing account fails the transaction.
    instructions.push(
      createAssociatedTokenAccountInstruction(owner, toTokenAccount, recipient, mint, TOKEN_PROGRAM_ID)
    );
  }

  instructions.push(
    createTransferCheckedInstruction(
      fromTokenAccount,
      mint,
      toTokenAccount,
      owner,
      amount,
      decimals,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: PRIVY_DUMMY_BLOCKHASH,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);

  return {
    transactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
    fromTokenAccount: fromTokenAccount.toBase58(),
    toTokenAccount: toTokenAccount.toBase58(),
    createsRecipientAccount: !toExists,
    estimatedRentSol: toExists ? 0 : TOKEN_ACCOUNT_RENT_SOL,
    instructionCount: instructions.length,
  };
}

/**
 * Will a transfer to this address have to CREATE the recipient's token account?
 *
 * Answered before the transfer is priced, because the answer costs Sivan about
 * $0.31 of sponsored rent and the user is entitled to see that in the quote
 * rather than discover it afterwards.
 *
 * Deliberately separate from buildSplTransfer, which answers the same question
 * as a side effect of constructing the transaction. Pricing happens earlier -
 * at the confirm dialog - and must not build and discard a transaction to get
 * one boolean.
 *
 * FAILS CLOSED TO `false`. An RPC error here would otherwise add a surcharge
 * the user did not incur, and overcharging on an unreadable network is worse
 * than absorbing the rent: the first is a complaint about being cheated, the
 * second is $0.31.
 */
export async function recipientNeedsTokenAccount(input: {
  recipientAddress: string;
  asset: string;
  production: boolean;
  rpcOptions?: SolanaRpcOptions;
}): Promise<boolean> {
  try {
    const mintAddress = solanaMintFor(input.asset, input.production);
    if (!mintAddress) return false;

    const mint = new PublicKey(mintAddress);
    const recipient = new PublicKey(input.recipientAddress);
    // allowOwnerOffCurve: an exchange deposit address is often a PDA.
    const ata = getAssociatedTokenAddressSync(mint, recipient, true);

    const exists = await accountExists(ata.toBase58(), {
      production: input.production,
      ...(input.rpcOptions ?? {}),
    });
    return !exists;
  } catch {
    return false;
  }
}
