/**
 * SIVAN MULTI-PROVIDER OFF-RAMP INTERFACE
 *
 * Pluggable abstraction contract for all cross-border and local currency cashouts.
 * Sivan payment Ai is not hardcoded to any single aggregator or blockchain rail.
 *
 * Regional and protocol providers implement this contract:
 * - Textile Credit (Celo cNGN / USDC / USDT -> Nigeria NIBSS)
 * - Breet (Base, Solana, Ethereum -> Nigeria NIBSS)
 * - Transfero / Pix (Celo wBRL / cREAL -> Brazil Pix)
 * - Ripio / Coelsa (Celo wARS -> Argentina CBU / CVU)
 * - Bitso / SPEI (Celo wMXN -> Mexico SPEI / CLABE)
 */

export type OfframpProviderName =
  | 'textile'
  | 'breet'
  | 'paystack'
  | 'transfero_pix'
  | 'ripio_cvu'
  | 'bitso_spei'
  | 'kotani'
  | string;

export interface OfframpBank {
  code: string;
  name: string;
  country: string;
}

export interface ResolveAccountInput {
  accountNumber: string; // NUBAN (10 digits), Pix Key (CPF/Email/Phone), or CVU (22 digits)
  bankCode?: string;
  country: string; // "NG", "BR", "MX", "AR", "KE", "GH"
}

export interface ResolvedAccountResult {
  valid: boolean;
  accountName: string;
  accountNumber: string;
  bankCode?: string;
  country: string;
  provider: OfframpProviderName;
}

export interface OfframpQuoteInput {
  country: string; // "NG", "BR", "MX", "AR", "KE", "GH"
  network: string; // "celo", "base", "solana", "arbitrum"
  sourceToken: string; // "cNGN", "USDC", "USDT", "wBRL", "wARS"
  amount: number; // e.g. 5000 cNGN or 10 USDC
  bankAccount?: string;
  bankCode?: string;
  userId?: string;
}

export interface OfframpQuoteResult {
  provider: OfframpProviderName;
  quoteId: string;
  country: string;
  network: string;
  sourceToken: string;
  inputAmount: number;
  rate: number;
  grossPayout: number;
  protocolFee: number;
  netPayout: number;
  destinationCurrency: string; // "NGN", "BRL", "MXN", "ARS"
  depositAddress: string; // On-chain settlement address
  validForSeconds: number;
  expiresAt: string;
  estimatedSettlement: string; // e.g. "Under 1 to 2 minutes via NIBSS / NIP"
}

export interface ExecuteOfframpInput {
  quoteId: string;
  txHash: string; // Confirmed on-chain transaction hash
  amount: number;
  sourceToken: string;
  network: string;
  country: string;
  bankAccount: string;
  bankCode?: string;
  senderAddress?: string;
  idempotencyKey: string;
}

export interface ExecuteOfframpResult {
  provider: OfframpProviderName;
  redemptionId: string;
  txHash: string;
  status: 'processing' | 'completed' | 'queued';
  settlementEta: string;
  deliveredVia: string;
}

export interface IOfframpProvider {
  readonly name: OfframpProviderName;
  readonly supportedCountries: readonly string[];
  readonly supportedNetworks: readonly string[];
  readonly supportedTokens: readonly string[];

  /**
   * Whether this provider has required credentials configured in the environment.
   */
  isConfigured(): boolean;

  /**
   * Lists commercial and microfinance banks for the target country.
   */
  listBanks(country: string): Promise<OfframpBank[]>;

  /**
   * Resolves recipient legal name before initiating transfer.
   */
  resolveAccount(input: ResolveAccountInput): Promise<ResolvedAccountResult>;

  /**
   * Generates a live firm or calibrated quote with protocol fee separation.
   */
  getQuote(input: OfframpQuoteInput): Promise<OfframpQuoteResult>;

  /**
   * Dispatches the fiat payout upon verified on-chain deposit.
   */
  executeOfframp(input: ExecuteOfframpInput): Promise<ExecuteOfframpResult>;

  /**
   * Polls the status of an active redemption.
   */
  getStatus(redemptionId: string): Promise<{ status: string; deliveredVia: string }>;
}
