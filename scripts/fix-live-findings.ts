/**
 * Turn the NGN rails on (or off) on a deployed API, and confirm it took.
 *
 * The off-ramp ships DISABLED, which is correct - a payments rail that is on
 * by default is a rail nobody decided to turn on. But that means enabling it
 * is a real launch step, and it is currently done by hand-crafting a curl with
 * an admin key in it.
 *
 * This does it, then RE-READS the operational health endpoint to prove the
 * change actually applied. A PUT that returns 200 against the wrong service,
 * or against a stale build, looks identical to one that worked.
 *
 * Defaults to a dry run. Nothing changes without --apply.
 *
 * Run:
 *   npm run ops:rails -- --api https://... --key <admin key>
 *   npm run ops:rails -- --api https://... --key <admin key> --apply
 *   npm run ops:rails -- --api https://... --key <admin key> --apply --off
 */

import 'dotenv/config';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const API = (arg('api') ?? process.env.OPS_API_URL ?? '').replace(/\/$/, '');
const KEY = arg('key') ?? process.env.ADMIN_API_KEY ?? '';
const APPLY = process.argv.includes('--apply');
const DISABLE = process.argv.includes('--off');

async function health() {
  const res = await fetch(`${API}/health/operational`);
  const body: any = await res.json().catch(() => null);
  return { status: res.status, body };
}

function printSignals(body: any) {
  if (!body?.signals) return console.log('    (no signals - endpoint not deployed?)');
  for (const s of body.signals) {
    const mark = s.severity === 'ok' ? '   ' : ' ! ';
    console.log(`   ${mark}[${String(s.severity).padEnd(8)}] ${s.name} = ${s.value}`);
    if (s.severity !== 'ok') console.log(`        ${s.detail}`);
  }
}

async function main() {
  if (!API) { console.error('Pass --api <url>'); process.exit(1); }
  if (!KEY) { console.error('Pass --key <admin api key>'); process.exit(1); }

  console.log(`\nTarget: ${API}`);
  console.log(APPLY ? (DISABLE ? 'Mode:   APPLY (disable rails)' : 'Mode:   APPLY (enable rails)') : 'Mode:   dry run — nothing will change');

  console.log('\nBefore:');
  const before = await health();
  console.log(`   HTTP ${before.status} · ${before.body?.status ?? '?'} · env ${before.body?.environment ?? '?'}`);
  printSignals(before.body);

  if (before.status === 404) {
    console.error('\n/health/operational is not deployed on this service. Deploy first, then re-run.');
    process.exit(1);
  }

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to change the rails.\n');
    return;
  }

  const desired = !DISABLE;
  const res = await fetch(`${API}/api/admin/ngn/controls`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-admin-api-key': KEY },
    body: JSON.stringify({
      offrampEnabled: desired,
      onrampEnabled: desired,
      bankSettlementEnabled: desired,
      updatedBy: 'ops:rails',
    }),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`\nPUT /api/admin/ngn/controls -> HTTP ${res.status}`);
  if (!res.ok) {
    console.error(JSON.stringify(body).slice(0, 400));
    process.exit(1);
  }

  // THE POINT. A 200 is not proof. Read the state back from the service's own
  // health endpoint, which computes it independently of the write path.
  console.log('\nAfter:');
  const after = await health();
  console.log(`   HTTP ${after.status} · ${after.body?.status ?? '?'}`);
  printSignals(after.body);

  const rails = (after.body?.signals ?? []).find((s: any) => s.name === 'ngn_offramp_enabled');
  const applied = Boolean(rails && (rails.value === 1) === desired);
  console.log(applied
    ? `\n✓ rails are now ${desired ? 'ENABLED' : 'DISABLED'}, confirmed by re-reading the service.\n`
    : `\n✗ the write returned 200 but the state did not change. Check you targeted the right service.\n`);
  if (!applied) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
