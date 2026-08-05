/**
 * EVERY TEST SUITE MUST BE REACHABLE FROM CI.
 *
 * The state this exists to prevent, discovered in exactly this repository:
 *
 *   package.json defined            108 test: scripts
 *   test-full-platform-e2e ran       28
 *   therefore never run by anything  79
 *
 * .github/workflows/ci.yml invokes test:full-platform-e2e and nothing else, so
 * those 79 suites - roughly 2,000 assertions - were commands a human could
 * choose to type. Among them was test:react-hook-order, written specifically
 * because React error #310 took the Receive screen to a blank error boundary
 * in production. The guard against that recurring had never run automatically.
 *
 * A test nobody runs is WORSE than no test. It reads as coverage in review, it
 * inflates the suite count, and it rots undetected. Wiring the 79 up
 * immediately surfaced two that had already gone stale against deliberate
 * product changes and were failing on a clean checkout of main.
 *
 * So the invariant is checked mechanically rather than by remembering: define
 * a suite, and CI runs it, or this fails.
 *
 * Run: npm run test:ci-coverage
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const runner = fs.readFileSync(path.join(root, 'scripts/test-full-platform-e2e.ts'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');

/**
 * Suites deliberately NOT in CI, each with a stated reason.
 *
 * An allow-list, not a pattern match: "anything containing 'live' is exempt"
 * is how a suite quietly opts itself out by being renamed. Adding an entry
 * here is a visible decision in a diff.
 */
const EXEMPT: Record<string, string> = {
  // Currently EMPTY, and that is the correct state.
  //
  // I first listed three here - test:paj-ngn-provider and
  // test:sivan-ai-remote-support as "hits a live sandbox", and
  // test:supplier-payments as a known pre-existing failure. This guard's own
  // "no suite is BOTH exempt and wired up" check rejected all three: every one
  // was already in the runner and had been for as long as it existed. My
  // exemptions were assumptions, not facts, and they would have quietly
  // excused three suites that CI has always enforced.
  //
  // Leaving it empty means all 107 suites block a deploy. If one genuinely
  // must not - a suite needing partner credentials a CI runner cannot hold -
  // add it with a reason, and the diff will show the decision.
};

const suites: string[] = Object.keys(pkg.scripts)
  .filter((name) => name.startsWith('test:'))
  // The runner cannot run itself, and this guard runs alongside it.
  .filter((name) => name !== 'test:full-platform-e2e' && name !== 'test:ci-coverage');

console.log('\n── every suite is reachable from CI ──────────────────────────');

const referenced = new Set([...runner.matchAll(/npm run (test:[a-z0-9:-]+)/g)].map((m) => m[1]));

const orphans = suites.filter((name) => !referenced.has(name) && !(name in EXEMPT));
check(`all ${suites.length} suites are wired up`,
  orphans.length === 0,
  orphans.length
    ? `${orphans.length} suite(s) exist but nothing runs them:\n       ` +
      orphans.join('\n       ') +
      '\n       Add them to paymentSteps in test-full-platform-e2e.ts, or delete them.'
    : '');

console.log('\n── exemptions are explicit and still real ────────────────────');

for (const [name, reason] of Object.entries(EXEMPT)) {
  check(`${name} is exempt: ${reason}`, true);
  // An exemption for a suite that no longer exists is dead config that hides
  // the next orphan behind a stale name.
  check(`  ...and ${name} still exists`, name in pkg.scripts,
    'exemption names a script that is gone - remove the exemption');
}

check('no suite is BOTH exempt and wired up',
  !Object.keys(EXEMPT).some((name) => referenced.has(name)),
  'an exemption that is also in the runner is misleading - drop one');

console.log('\n── CI actually invokes the runner ────────────────────────────');

check('the workflow runs test:full-platform-e2e',
  workflow.includes('npm run test:full-platform-e2e'),
  'this guard is worthless if the runner itself is not called');
check('the workflow triggers on push to main',
  /branches:[\s\S]{0,80}- main/.test(workflow));
check('the workflow triggers on pull requests',
  /pull_request:/.test(workflow));

console.log('\n── steps that depend on an install run after it ──────────────');

/**
 * ORDERING IS A REAL FAILURE MODE HERE, not a tidiness preference.
 *
 * `npm run typecheck` also runs tsconfig.scripts.json, which deliberately sees
 * frontend source so the test suites assert against real frontend modules.
 * Those import react and qrcode-generator from frontend/node_modules. With the
 * frontend install placed after the typecheck, CI failed on every clean
 * checkout with TS2307 "Cannot find module 'react'" - while passing on any
 * machine that had run the frontend once. Exactly the class of bug that only
 * appears on the deploy.
 */
const feInstall = runner.indexOf("npm --prefix frontend ci");
const backendTypecheck = runner.indexOf("command: 'npm run typecheck'");
const feLint = runner.indexOf('npm --prefix frontend run lint:ci');
const feBuild = runner.indexOf('npm --prefix frontend run build');

check('the frontend install comes before the backend typecheck',
  feInstall > 0 && backendTypecheck > 0 && feInstall < backendTypecheck,
  'typecheck reads frontend source through tsconfig.scripts.json');
check('the frontend install comes before the frontend lint',
  feInstall < feLint, 'eslint cannot resolve imports without node_modules');
check('the frontend install comes before the frontend build',
  feInstall < feBuild);

console.log('\n── the runner treats every step as blocking ──────────────────');

/**
 * `required` MUST ACTUALLY BE READ, not merely declared.
 *
 * It was on the Step type from the beginning and nothing ever consulted it -
 * runStep marked any non-zero exit as 'failed' and the summary failed the job
 * on all of them. So `required: false` was a silent no-op, and my first
 * attempt at an advisory step would have blocked the build anyway while
 * looking like it did not.
 *
 * Asserting the declaration exists is what let that hide. Assert the
 * behaviour: the failure filter has to distinguish required from advisory.
 */
check('steps default to required',
  runner.includes('required: step.required ?? true'),
  'a non-blocking test is a test that does not exist');
check('and `required` is actually consulted when deciding pass/fail',
  /allFailed\.filter\(\(result\) => result\.required !== false\)/.test(runner),
  'required was declared and never read - required:false was a no-op');
check('advisory failures are still reported, not hidden',
  runner.includes('Advisory (not blocking)'),
  'a non-blocking step that prints nothing is a deleted step');

// Counted on STEP DEFINITIONS only. A bare /required:\s*false/ also matches
// the prose in the runner's own comments explaining the mechanism, which made
// this read 2 when there is exactly one advisory step.
const advisoryCount = [...runner.matchAll(/command:\s*'[^']*',\s*required:\s*false/g)].length;
check('at most one step is advisory',
  advisoryCount <= 1,
  `${advisoryCount} advisory steps - each one is a hole in the gate and needs justifying`);
check('a non-zero exit fails the job',
  /process\.exit\(\s*(?:failed\.length|report\.ok)/.test(runner) ||
  runner.includes('process.exitCode') || runner.includes('process.exit(1)'),
  'the runner must propagate failure to the CI job');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
