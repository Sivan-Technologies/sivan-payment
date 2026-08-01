import { z } from 'zod';
import { db } from '../database/json-database.js';
import { badRequest } from '../shared/errors.js';
import { nowIso } from '../shared/id.js';
import { env } from '../config/env.js';
import { createAuditLog } from '../audit/audit.service.js';
import type { WalletControlsRecord } from '../database/types.js';

/**
 * Which wallet provider issues new wallets, set by an admin rather than by a
 * redeploy.
 *
 * WALLET_PROVIDER lived only in the environment, so changing custody provider
 * meant editing Render config and restarting. Same argument that already moved
 * the NGN provider and the verification ceilings into the database.
 *
 * WHY THIS IS SAFE TO CHANGE AT RUNTIME, AND WHERE IT IS NOT
 *
 * Every wallet row records the provider that issued it, so switching the
 * default decides who issues the NEXT wallet and never orphans an existing
 * one - a Bridge wallet keeps resolving to Bridge after the default becomes
 * Privy.
 *
 * What it does NOT do is migrate anyone. A user with a Bridge wallet does not
 * acquire a Privy one by an admin flipping this, and a Privy wallet created
 * before a delegated signer existed cannot gain one later - Privy attaches
 * additional signers at creation only. So this is a forward-looking switch,
 * and the API says so rather than implying a migration.
 */

const PROVIDERS = ['privy', 'bridge', 'mock'] as const;

export const updateWalletControlsSchema = z.object({
  /**
   * null clears the override and returns to the WALLET_PROVIDER environment
   * variable. Distinct from omitting the field, which leaves it unchanged.
   */
  activeProvider: z.enum(PROVIDERS).nullable().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
  updatedBy: z.string().trim().min(1).optional(),
});

export function defaultWalletControls(): WalletControlsRecord {
  return {
    id: 'global',
    // NULL, not a provider name. The environment stays authoritative until an
    // admin deliberately overrides it, so adding this table changes nothing on
    // its own.
    activeProvider: undefined,
    updatedBy: 'system',
    updatedAt: nowIso(),
  };
}

export async function getWalletControls(): Promise<WalletControlsRecord> {
  const existing = (await db.listWalletControls?.()) ?? [];
  return existing.find((item) => item.id === 'global') ?? defaultWalletControls();
}

/**
 * The provider name to use, admin override first.
 *
 * Async, and therefore NOT called from inside getWalletProvider() - that
 * function is synchronous and used in hot paths. Callers resolve the name
 * first and pass it in, which also keeps the registry testable without a
 * database.
 */
export async function resolveActiveWalletProvider(): Promise<string> {
  const controls = await getWalletControls();
  return controls.activeProvider || process.env.WALLET_PROVIDER || env.WALLET_PROVIDER || 'mock';
}

export async function updateWalletControls(input: z.infer<typeof updateWalletControlsSchema>) {
  // Validated HERE, not only at the route. parseBody guards the HTTP path, but
  // a service called directly - by a script, a migration, a future internal
  // caller - would otherwise write an unknown provider name straight to the
  // database, and getWalletProvider() would then throw for every user until
  // someone worked out why.
  const parsed = updateWalletControlsSchema.safeParse(input);
  if (!parsed.success) {
    throw badRequest(
      `Invalid wallet controls: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`
    );
  }
  input = parsed.data;

  const current = await getWalletControls();

  // Switching to mock in production would hand out addresses nobody controls.
  // The registry refuses this too, but failing at configuration time is far
  // better than at the moment a user asks for a wallet.
  if (input.activeProvider === 'mock' && env.APP_ENV === 'production') {
    throw badRequest('The mock wallet provider cannot be enabled in production.');
  }

  const next: WalletControlsRecord = {
    ...current,
    activeProvider:
      input.activeProvider === null ? undefined : input.activeProvider ?? current.activeProvider,
    reason: input.reason ?? current.reason,
    updatedBy: input.updatedBy ?? 'admin_api_key',
    updatedAt: nowIso(),
  };

  await db.upsertWalletControlsRecord(next);

  // Severity warning: this changes who custodies user funds, which is the sort
  // of change an incident review asks about.
  await createAuditLog({
    actorType: 'admin',
    actorId: next.updatedBy,
    action: 'wallets.controls_updated',
    resourceType: 'payments_wallet_controls',
    resourceId: 'global',
    severity: 'warning',
    metadata: {
      previousProvider: current.activeProvider ?? '(environment)',
      nextProvider: next.activeProvider ?? '(environment)',
      reason: next.reason,
    },
  });

  return next;
}

/**
 * What an admin screen needs to make this decision safely.
 *
 * Shows the environment default alongside the override, because an operator
 * cannot judge a switch without seeing what it is switching FROM. Also states
 * plainly that the change is forward-looking, since the obvious wrong
 * assumption is that existing users get migrated.
 */
export async function getWalletControlsView() {
  const controls = await getWalletControls();
  const envProvider = process.env.WALLET_PROVIDER || env.WALLET_PROVIDER || 'mock';

  return {
    activeProvider: controls.activeProvider ?? envProvider,
    overrideProvider: controls.activeProvider,
    environmentProvider: envProvider,
    isOverridden: Boolean(controls.activeProvider),
    availableProviders: PROVIDERS.filter(
      (name) => !(name === 'mock' && env.APP_ENV === 'production')
    ),
    reason: controls.reason,
    updatedBy: controls.updatedBy,
    updatedAt: controls.updatedAt,
    note:
      'Applies to NEWLY created wallets only. Existing wallets keep the provider that issued ' +
      'them, and a Privy wallet created without a delegated signer cannot gain one later.',
  };
}
