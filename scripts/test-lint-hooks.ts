/**
 * THE HOOK RULE MUST BE ON, AND MUST BE AN ERROR.
 *
 * React error #310 - "Rendered more hooks than during the previous render" -
 * shipped to production and showed the Receive screen as a blank page reading
 * "Something went wrong". Cause: a useMemo added below three early returns in
 * cae1683. React identifies hooks by call order, so a hook beneath a
 * conditional return changes the count between renders and React throws.
 *
 * TypeScript cannot catch it. The screen typechecked and built cleanly all the
 * way to a user's browser, because it is a control-flow rule and not a type
 * error. There was no ESLint in this project at all - no config, no dependency,
 * in either package.json - so nothing stood in the way.
 *
 * This suite asserts the guard is genuinely wired, not merely installed. Each
 * check corresponds to a way the protection could be silently lost:
 * the plugin removed, the rule downgraded to a warning, lint dropped from CI,
 * or the ratchet loosened until warnings stop mattering.
 *
 * Run: npm run test:lint-hooks
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fe = path.join(root, 'frontend');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const config = fs.readFileSync(path.join(fe, 'eslint.config.js'), 'utf8');
const fePkg = JSON.parse(fs.readFileSync(path.join(fe, 'package.json'), 'utf8'));
const runner = fs.readFileSync(path.join(root, 'scripts/test-full-platform-e2e.ts'), 'utf8');

console.log('\n── the plugin is installed and configured ────────────────────');

check('eslint-plugin-react-hooks is a dependency',
  'eslint-plugin-react-hooks' in (fePkg.devDependencies ?? {}));
check('eslint itself is a dependency', 'eslint' in (fePkg.devDependencies ?? {}));
check('the config registers the react-hooks plugin',
  /plugins:\s*\{[\s\S]{0,200}'react-hooks'/.test(config));

console.log('\n── rules-of-hooks is an ERROR, not a warning ─────────────────');

check("rules-of-hooks is set to 'error'",
  /'react-hooks\/rules-of-hooks':\s*'error'/.test(config),
  "a warning in a pipeline nobody reads is the same as no rule - that is how #310 shipped");
check('exhaustive-deps is at least enabled',
  /'react-hooks\/exhaustive-deps':\s*'(error|warn)'/.test(config),
  'stale closures are the other half of what this plugin exists for');

console.log('\n── lint runs in CI, and blocks ───────────────────────────────');

check('the frontend has a lint:ci script', typeof fePkg.scripts?.['lint:ci'] === 'string');
check('lint:ci caps warnings so debt cannot grow',
  /--max-warnings\s+\d+/.test(fePkg.scripts?.['lint:ci'] ?? ''),
  'without a cap, new warnings are invisible');
check('the platform runner invokes it',
  runner.includes('npm --prefix frontend run lint:ci'),
  'CI runs test:full-platform-e2e and nothing else; if lint is not in there it does not run');
// Compared against the FRONTEND build specifically. `run build` on its own
// also matches the backend build step much earlier in the file, which made
// this assertion fail against a correctly-ordered runner.
check('lint runs BEFORE the frontend build',
  runner.indexOf('npm --prefix frontend run lint:ci') <
  runner.indexOf('npm --prefix frontend run build'),
  'a hook violation builds fine, so the build passing proves nothing about it');

console.log('\n── and it actually catches the real bug ──────────────────────');

/**
 * The load-bearing check. Everything above is configuration; this proves the
 * configuration WORKS, by reproducing the exact shape that reached production
 * and requiring ESLint to reject it.
 */
const probeDir = path.join(fe, 'src');
const probe = path.join(probeDir, '__hook_probe__.tsx');
fs.writeFileSync(probe, `import { useMemo } from 'react';
export function HookProbe({ ready, items }: { ready: boolean; items: string[] }) {
  if (!ready) return <div>loading</div>;
  const first = useMemo(() => items[0], [items]);
  return <div>{first}</div>;
}
`);

let probeOutput = '';
let probeFailed = false;
try {
  execFileSync(path.join(fe, 'node_modules/.bin/eslint'), ['src/__hook_probe__.tsx'], {
    cwd: fe, encoding: 'utf8',
  });
} catch (error: any) {
  probeFailed = true;
  probeOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`;
} finally {
  fs.rmSync(probe, { force: true });
}

check('a hook below an early return is rejected', probeFailed,
  'ESLint accepted the exact shape that took the Receive screen down');
check('and it is reported as an error by rules-of-hooks',
  /rules-of-hooks/.test(probeOutput) && / error /.test(probeOutput),
  probeOutput.split('\n').filter(Boolean).slice(0, 3).join(' | '));
check('the message names the cause, so the next person can act on it',
  /called conditionally|same order in every component render/i.test(probeOutput),
  probeOutput.slice(0, 160));

console.log('\n── the existing codebase is clean of hook-order violations ───');

let repoOutput = '';
try {
  repoOutput = execFileSync(path.join(fe, 'node_modules/.bin/eslint'), ['.', '-f', 'json'], {
    cwd: fe, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
} catch (error: any) {
  repoOutput = error.stdout ?? '[]';
}
const results = JSON.parse(repoOutput || '[]');
const hookViolations = results.flatMap((file: any) =>
  (file.messages ?? [])
    .filter((m: any) => m.ruleId === 'react-hooks/rules-of-hooks')
    .map((m: any) => `${path.relative(fe, file.filePath)}:${m.line}`)
);
check('no component calls a hook conditionally',
  hookViolations.length === 0,
  hookViolations.join(', '));

const errors = results.flatMap((file: any) =>
  (file.messages ?? []).filter((m: any) => m.severity === 2)
    .map((m: any) => `${path.relative(fe, file.filePath)}:${m.line} ${m.ruleId}`)
);
check('the frontend lints with zero errors', errors.length === 0, errors.slice(0, 5).join(' | '));

console.log('\n── the hand-written scanner is kept as a second opinion ──────');

check('test:react-hook-order still exists',
  fs.existsSync(path.join(root, 'scripts/test-react-hook-order.ts')),
  'it pins the specific ReceiveView regression by name, which a generic rule cannot express');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
