import { celoRpc, CELO_CNGN_MAINNET } from './celo-rpc.js';
import { resolveNetworkMode } from '../network-mode.js';

/**
 * Celo Fee Abstraction — Fee Currency Registry
 *
 * Celo's fee abstraction is a native protocol feature (not a paymaster, not a
 * relayer, not a Privy dashboard toggle). Any transaction can include a
 * `feeCurrency` field pointing to a whitelisted ERC-20 token. The Celo node
 * calls `debitGasFees` on the fee currency contract to reserve gas in that
 * token, executes the transaction, then calls `creditGasFees` to refund unused
 * gas. No CELO balance required by the user at any point.
 *
 * USDC and USDT use 6 decimals on Celo, but the node's gas pricing uses 18.
 * An adapter contract bridges the precision gap — the `feeCurrency` field must
 * point to the ADAPTER, not to the raw token address.
 *
 * cUSD (USDm) uses 18 decimals natively; no adapter is needed. Its token
 * address is passed directly.
 *
 * Priority resolution order (see resolveCeloFeeCurrency):
 *   1. USDC adapter  — preferred, most liquid on Celo
 *   2. USDT adapter  — second choice
 *   3. cUSD direct   — fallback; nearly every Celo wallet carries some cUSD
 *
 * References:
 *   https://docs.celo.org/build-on-celo/fee-abstraction/overview
 *   https://docs.celo.org/tooling/contracts/fee-currencies
 */

// ---------------------------------------------------------------------------
// Mainnet adapter addresses (chain ID 42220)
// ---------------------------------------------------------------------------

/** USDC fee-currency adapter — bridges 6-decimal USDC to 18-decimal gas pricing */
const CELO_USDC_FEE_ADAPTER_MAINNET = '0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B';

/** USDT fee-currency adapter — bridges 6-decimal USDT to 18-decimal gas pricing */
const CELO_USDT_FEE_ADAPTER_MAINNET = '0x0e2a3e05bc9a16f5292a6170456a710cb89c6f72';

/** cUSD (USDm) — 18 decimals, no adapter needed, direct token address */
const CELO_CUSD_MAINNET = '0x765DE816845861e75A25fCA122bb6898B8B1282a';

// ---------------------------------------------------------------------------
// Testnet adapter addresses (Celo Sepolia, chain ID 11142220)
// ---------------------------------------------------------------------------

/** USDC fee-currency adapter — Celo Sepolia testnet */
const CELO_USDC_FEE_ADAPTER_TESTNET = '0xbf1441Ea57f43f35f713431001f35742c88071c7';

/** USDT fee-currency adapter — Celo Sepolia testnet */
const CELO_USDT_FEE_ADAPTER_TESTNET = '0xe19447B12cb0d0220B2a501D8382be2f61CcF92a';

/** cUSD (USDm) — Celo Sepolia testnet */
const CELO_CUSD_TESTNET = '0xEF4d55D6dE8e8d73232827Cd1e9b2F2dBb45bC80';

// ---------------------------------------------------------------------------
// ERC-20 token addresses used for balance checks (not fee currency)
// ---------------------------------------------------------------------------

/** Raw USDC token address on Celo mainnet — for balance checking only */
const CELO_USDC_TOKEN_MAINNET = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C';

/** Raw USDC token address on Celo Sepolia — for balance checking only */
const CELO_USDC_TOKEN_TESTNET = '0x01C5C0122039549AD1493B8220cABEdD739BC44E';

/** Raw USDT token address on Celo mainnet — for balance checking only */
const CELO_USDT_TOKEN_MAINNET = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e';

/** Raw USDT token address on Celo Sepolia — for balance checking only */
const CELO_USDT_TOKEN_TESTNET = '0xd077A400968890Eacc75cdc901F0356c943e4fDb';

// ---------------------------------------------------------------------------
// Public registry — all addresses resolved per environment
// ---------------------------------------------------------------------------

export interface CeloFeeCurrencyRegistry {
  usdcAdapter: string;
  usdtAdapter: string;
  cusd: string;
  usdcToken: string;
  usdtToken: string;
  /** cNGN token address for balance awareness (not a fee currency itself) */
  cngnToken: string;
}

export function getCeloFeeCurrencyRegistry(options?: { production?: boolean }): CeloFeeCurrencyRegistry {
  const isMainnet = typeof options?.production === 'boolean'
    ? options.production
    : resolveNetworkMode() === 'mainnet';

  return {
    usdcAdapter: isMainnet ? CELO_USDC_FEE_ADAPTER_MAINNET : CELO_USDC_FEE_ADAPTER_TESTNET,
    usdtAdapter: isMainnet ? CELO_USDT_FEE_ADAPTER_MAINNET : CELO_USDT_FEE_ADAPTER_TESTNET,
    cusd:        isMainnet ? CELO_CUSD_MAINNET             : CELO_CUSD_TESTNET,
    usdcToken:   isMainnet ? CELO_USDC_TOKEN_MAINNET       : CELO_USDC_TOKEN_TESTNET,
    usdtToken:   isMainnet ? CELO_USDT_TOKEN_MAINNET       : CELO_USDT_TOKEN_TESTNET,
    cngnToken:   isMainnet ? CELO_CNGN_MAINNET             : CELO_CNGN_MAINNET,
  };
}

// ---------------------------------------------------------------------------
// Balance check — ERC-20 balanceOf via Celo JSON-RPC
// ---------------------------------------------------------------------------

const ERC20_BALANCE_OF_SELECTOR = '0x70a08231'; // balanceOf(address)

async function fetchErc20Balance(
  tokenAddress: string,
  walletAddress: string,
  options?: { production?: boolean }
): Promise<bigint> {
  try {
    const paddedAddress = walletAddress.slice(2).toLowerCase().padStart(64, '0');
    const data = ERC20_BALANCE_OF_SELECTOR + paddedAddress;
    const result = await celoRpc<string>('eth_call', [
      { to: tokenAddress, data },
      'latest',
    ], options);
    return result && result !== '0x' ? BigInt(result) : 0n;
  } catch {
    return 0n;
  }
}

/**
 * Fetches the raw on-chain cNGN balance for a given wallet address.
 * Returns the balance as a bigint in the smallest unit (6 decimals).
 * Used by CeloAdapter.getBalance('cngn') since wallet providers may not index cNGN.
 */
export async function fetchCngnBalance(
  walletAddress: string,
  options?: { production?: boolean }
): Promise<bigint> {
  const registry = getCeloFeeCurrencyRegistry(options);
  return fetchErc20Balance(registry.cngnToken, walletAddress, options);
}

// ---------------------------------------------------------------------------
// resolveCeloFeeCurrency — the single entry point used by CeloAdapter
// ---------------------------------------------------------------------------

export interface FeeCurrencyResolution {
  feeCurrencyAddress: string;
  paidIn: 'usdc' | 'usdt' | 'cusd';
}

/**
 * Resolves which fee currency to use for a Celo transaction.
 *
 * Checks the user's wallet balances in priority order and returns the adapter
 * address of whichever token they hold. The gas cost is a fraction of a cent
 * (~0.0001 USDC equivalent) so the token choice is invisible to the user.
 *
 * @param walletAddress - The user's Celo wallet address (0x...)
 * @param options - Network mode override (production / testnet)
 * @throws If the wallet holds no supported stablecoin at all
 */
export async function resolveCeloFeeCurrency(
  walletAddress: string,
  options?: { production?: boolean }
): Promise<FeeCurrencyResolution> {
  const registry = getCeloFeeCurrencyRegistry(options);

  // Priority 1: USDC
  const usdcBalance = await fetchErc20Balance(registry.usdcToken, walletAddress, options);
  if (usdcBalance > 0n) {
    return { feeCurrencyAddress: registry.usdcAdapter, paidIn: 'usdc' };
  }

  // Priority 2: USDT
  const usdtBalance = await fetchErc20Balance(registry.usdtToken, walletAddress, options);
  if (usdtBalance > 0n) {
    return { feeCurrencyAddress: registry.usdtAdapter, paidIn: 'usdt' };
  }

  // Priority 3: cUSD fallback — nearly every Celo wallet carries some
  const cusdBalance = await fetchErc20Balance(registry.cusd, walletAddress, options);
  if (cusdBalance > 0n) {
    return { feeCurrencyAddress: registry.cusd, paidIn: 'cusd' };
  }

  // No supported stablecoin found — reject clearly
  throw new Error(
    'Celo transfer failed: wallet holds no USDC, USDT, or cUSD to cover the network fee. ' +
    'Please top up your wallet with any supported stablecoin before sending.'
  );
}
