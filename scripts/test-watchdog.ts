/**
 * The watchdog's alerting logic.
 *
 * THE DE-DUPLICATION IS THE WHOLE TEST.
 *
 * An alerting system that fires every minute during an incident gets muted,
 * and a muted channel is worse than no channel: it looks like coverage and
 * provides none. So the behaviour that actually matters is not "does it
 * detect" - it is "does it shut up once it has told you, and does it speak
 * again when things change".
 *
 * probe() is driven with a stub fetch so the HTTP shapes are real without a
 * network, and decideAlert() is pure so a multi-hour incident can be
 * simulated in milliseconds.
 *
 * Run: npm run test:watchdog
 */

import { probe, decideAlert } from './watchdog.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

/** A fetch that returns a fixed status and body. */
function stubFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

function throwingFetch(message: string): typeof fetch {
  return (async () => { throw new Error(message); }) as unknown as typeof fetch;
}

const healthy = { status: 'ok', signals: [{ name: 'a', severity: 'ok', value: 0, detail: 'fine' }] };
const critical = {
  status: 'critical',
  signals: [
    { name: 'transfers_stuck_in_flight', severity: 'critical', value: 3, detail: '3 transfer(s) unfinished for over 2h. Check the Breet webhook log.' },
    { name: 'ngn_offramp_enabled', severity: 'ok', value: 1, detail: 'enabled' },
  ],
};

async function main() {
  console.log('\nREADING THE ENDPOINT');
  {
    const ok = await probe('https://x.test', stubFetch(200, healthy));
    check('a healthy service reads ok', ok.state === 'ok', ok.state);
    check('and reports no problems', ok.problems.length === 0);

    const bad = await probe('https://x.test', stubFetch(503, critical));
    check('a 503 reads critical', bad.state === 'critical', bad.state);
    check('only non-ok signals are surfaced', bad.problems.length === 1, String(bad.problems.length));
    check('and the problem carries the ACTION, not just a name',
      /Breet webhook log/.test(bad.problems[0]), bad.problems[0]);
  }

  console.log('\nA MISSING ENDPOINT IS AN INCIDENT, NOT SILENCE');
  {
    // This is the stale-deploy case. /health returns 200 on old code while
    // /health/operational 404s - exactly what happened for six commits when
    // migration 036 broke the build. Reading that as "no problems" would
    // reproduce the outage that this endpoint exists to prevent.
    const missing = await probe('https://x.test', stubFetch(404, { message: 'not found' }));
    check('a 404 is critical, not ok', missing.state === 'critical', missing.state);
    check('and it names a stale build as the cause',
      /not deployed|stale/i.test(missing.problems[0]), missing.problems[0]);
  }

  console.log('\nAN UNREACHABLE HOST IS DISTINGUISHED FROM AN UNHEALTHY ONE');
  {
    const dead = await probe('https://x.test', throwingFetch('connect ECONNREFUSED'));
    check('a network failure is unreachable', dead.state === 'unreachable', dead.state);
    check('and the cause is kept', /ECONNREFUSED/.test(dead.error ?? ''), dead.error);

    const garbage = await probe('https://x.test', stubFetch(200, 'not json at all'));
    check('a 200 with an unparseable body is not treated as healthy',
      garbage.state === 'unreachable', garbage.state);
  }

  console.log('\nONE BLIP DOES NOT PAGE ANYONE');
  {
    // Render cold starts routinely take longer than a timeout. Alerting on
    // the first miss trains an operator to ignore the channel.
    let state = { alertedState: 'ok' as const, consecutiveFailures: 0 };
    const first = decideAlert(state, 'unreachable');
    check('the first failure is silent', !first.alert);
    check('but it is remembered', first.nextState.consecutiveFailures === 1);

    const second = decideAlert(first.nextState, 'unreachable');
    check('the second consecutive failure alerts', second.alert && second.kind === 'down');
  }

  console.log('\nAND IT SHUTS UP AFTERWARDS');
  {
    let state = { alertedState: 'ok' as State_, consecutiveFailures: 0 };
    let alerts = 0;
    // Simulate a four-hour incident at one poll per minute.
    for (let minute = 0; minute < 240; minute++) {
      const decision = decideAlert(state, 'critical');
      if (decision.alert) alerts += 1;
      state = decision.nextState;
    }
    check('a 4-hour incident sends exactly ONE alert, not 240',
      alerts === 1, `${alerts} alerts`);

    // Recovery must be announced, or nobody knows to stop worrying.
    const recovered = decideAlert(state, 'ok');
    check('recovery is announced', recovered.alert && recovered.kind === 'recovered');
    check('and the state resets', recovered.nextState.consecutiveFailures === 0);

    // ...but only once.
    let after = recovered.nextState;
    let extra = 0;
    for (let i = 0; i < 60; i++) {
      const d = decideAlert(after, 'ok');
      if (d.alert) extra += 1;
      after = d.nextState;
    }
    check('a healthy hour after recovery is silent', extra === 0, `${extra} alerts`);
  }

  console.log('\nA HEALTHY START NEVER SENDS "RECOVERED"');
  {
    // Every restart would otherwise announce a recovery from an outage that
    // never happened, which is how people learn to ignore the channel.
    const fresh = decideAlert({ alertedState: 'ok', consecutiveFailures: 0 }, 'ok');
    check('a first healthy poll is silent', !fresh.alert);
  }

  console.log('\nA CHANGE OF FAILURE MODE IS WORTH SAYING');
  {
    // critical (responding, but broken) -> unreachable (gone) is an
    // escalation an operator needs to know about.
    let state = { alertedState: 'ok' as State_, consecutiveFailures: 0 };
    state = decideAlert(state, 'critical').nextState;
    state = decideAlert(state, 'critical').nextState;
    check('the service is in the alerted-critical state', state.alertedState === 'critical');

    const escalated = decideAlert(state, 'unreachable');
    check('critical -> unreachable alerts again', escalated.alert && escalated.kind === 'down');

    const same = decideAlert(escalated.nextState, 'unreachable');
    check('but it then stays quiet', !same.alert);
  }

  console.log('\nWARN DOES NOT WAKE ANYONE');
  {
    // A slow review queue at 3am is a morning problem. Only critical and
    // unreachable page - matching the endpoint, which returns 200 for warn.
    const warned = decideAlert({ alertedState: 'ok', consecutiveFailures: 0 }, 'warn');
    check('a warn state does not alert', !warned.alert);
    check('and does not count as a failure', warned.nextState.consecutiveFailures === 0);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

type State_ = 'ok' | 'warn' | 'critical' | 'unreachable';

main().catch((error) => { console.error(error); process.exit(1); });
