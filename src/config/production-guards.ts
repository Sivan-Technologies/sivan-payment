/**
 * Production configuration that must be right BEFORE the process serves
 * traffic, not discovered when a user trips over it.
 *
 * WHY THESE TWO ARE DIFFERENT FROM THE GUARDS ALREADY IN buildApp().
 *
 * ADMIN_API_KEY and USER_JWT_SECRET fail immediately and everywhere. These two
 * fail LATE and QUIETLY - the deploy goes green, every route works, and the
 * fault surfaces hours later as one user's failed request:
 *
 *   VIRTUAL_ACCOUNT_PROVIDER defaults to 'mock' in env.ts. The virtual-account
 *   registry does refuse mock in production, but only when a provider is
 *   ASKED FOR - i.e. when a user requests an account. render.yaml records that
 *   this already happened once: "Was unset, and env.ts defaults
 *   VIRTUAL_ACCOUNT_PROVIDER to mock. A production virtual account must be
 *   issued by Bridge, not fabricated." A fabricated account hands a real
 *   person bank details no bank will honour.
 *
 *   BRIDGE_WALLETS_APPROVED gates getWalletProvider('bridge'), also lazily.
 *   Virtual accounts settle INTO a Bridge wallet and the Bridge -> Privy sweep
 *   reads it, so a missing flag stops settlement for every user with nothing
 *   on screen to say so.
 *
 * Both are one-line environment mistakes with no symptom at deploy time. That
 * is exactly what a boot assertion is for.
 */

export interface ProductionWalletConfig {
  appEnv: string;
  virtualAccountsEnabled: boolean;
  virtualAccountProvider?: string;
  /**
   * The RAW string, deliberately - not a parsed boolean.
   *
   * This is a compliance attestation ("Bridge Legal & Compliance approved our
   * wallet fund flow"), and it is read with a literal `!== 'true'` comparison
   * in provider-registry.ts. Parsing it here with something more permissive
   * than that would let a value the registry rejects pass the boot check, so
   * the two would disagree about whether the service can work.
   */
  bridgeWalletsApproved?: string;
  activeWalletProvider?: string;
}

/**
 * STAGING IS DELIBERATELY EXCLUDED.
 *
 * api-test runs APP_ENV=staging with mock providers on purpose. app.ts already
 * records a guard that was written production-or-staging and would have
 * crash-looped exactly that rig. The hazard here is real money and real bank
 * details, which is production only.
 */
function appliesTo(appEnv: string): boolean {
  return appEnv === 'production';
}

/** Matches provider-registry.ts exactly: only the literal string `true`. */
function isApproved(value: string | undefined): boolean {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

export function assertProductionWalletConfig(config: ProductionWalletConfig): void {
  if (!appliesTo(config.appEnv)) return;

  const provider = String(config.virtualAccountProvider ?? 'mock').trim().toLowerCase();

  /**
   * Only when virtual accounts are actually ON. Refusing otherwise would
   * crash-loop a deployment over a feature it never offers, taking down NGN
   * off-ramp, balances and support with it - a far worse outcome than the
   * fault being guarded against.
   */
  if (config.virtualAccountsEnabled && provider === 'mock') {
    throw new Error(
      'VIRTUAL_ACCOUNT_PROVIDER is "mock" in production while VIRTUAL_ACCOUNTS_ENABLED is true. ' +
      'A mock virtual account fabricates bank details that no bank will honour, and a user who ' +
      'wires money to them loses it. Set VIRTUAL_ACCOUNT_PROVIDER=bridge.'
    );
  }

  /**
   * A Bridge wallet is constructed in two situations: virtual-account
   * settlement (and the sweep that follows it), and Bridge being the active
   * issuer. Either one needs the approval; neither being true means no Bridge
   * wallet is ever built and the flag is irrelevant.
   */
  const needsBridgeWallets =
    config.virtualAccountsEnabled ||
    String(config.activeWalletProvider ?? '').trim().toLowerCase() === 'bridge';

  if (needsBridgeWallets && !isApproved(config.bridgeWalletsApproved)) {
    throw new Error(
      'BRIDGE_WALLETS_APPROVED must be exactly "true" in production when Bridge wallets are in use. ' +
      'Bridge require Legal & Compliance sign-off on the wallet fund flow before production use, and ' +
      'this variable is that attestation - not a feature toggle. Without it, virtual-account ' +
      'settlement and the Bridge to Privy sweep fail for every user.'
    );
  }
}
