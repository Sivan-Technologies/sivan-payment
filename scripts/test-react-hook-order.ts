/**
 * NO HOOK MAY SIT BELOW AN EARLY RETURN.
 *
 * Shipped as React error #310 - "Rendered more hooks than during the previous
 * render" - on the Receive screen, which crashed to the error boundary and
 * showed the user a blank page with "Something went wrong."
 *
 * I caused it in cae1683. Fixing the wallet lookup, I wrapped it in useMemo:
 *
 *   const wallet = useMemo(() => { ... }, [wallets, activeChain]);
 *
 * That line sits AFTER three early returns - walletsEnabled, the verification
 * gate, and availableChains. React identifies hooks by call ORDER, so a hook
 * beneath a conditional return runs only when every guard passes. The moment
 * one of them fires - which is the normal first render, before wallets have
 * loaded - the count changes and React throws.
 *
 * TypeScript cannot catch this. It is not a type error, it is a control-flow
 * rule, and the screen compiled and built cleanly all the way to production.
 * The project has no eslint-plugin-react-hooks in its pipeline, so nothing
 * stood between that edit and a blank screen.
 *
 * Verified in a real browser before writing this: the old shape crashes to an
 * error boundary on the guard-false-to-true transition, the new shape renders.
 *
 * The useMemo was never needed either - two array scans over a list that is
 * almost always length 2. It cost more than it saved and bought a crash.
 *
 * Run: npm run test:react-hook-order
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const componentsDir = path.join(root, 'frontend/src');

const HOOK = /\b(useState|useEffect|useMemo|useCallback|useRef|useReducer|useLayoutEffect|useTransition|useDeferredValue)\s*\(/;

/** Comments discuss hooks constantly; only real calls count. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
};

console.log('\n── every component: hooks above the guards ────────────────────');

const violations: string[] = [];
let scanned = 0;

for (const file of walk(componentsDir)) {
  const source = stripComments(fs.readFileSync(file, 'utf8'));
  // Component declarations at column 0. Nested helpers are not components and
  // cannot own hooks anyway.
  for (const match of source.matchAll(/^(?:export )?function ([A-Z]\w*)\(/gm)) {
    scanned += 1;
    const name = match[1];
    const start = match.index ?? 0;
    const rest = source.slice(start + 10);
    const next = rest.search(/^(?:export )?(?:function|const) /m);
    const body = source.slice(start, next < 0 ? source.length : start + 10 + next);

    // An early return at the component's top level - two spaces of indent.
    const early = body.match(/\n {2}if \([^\n]*\) \{\n {4}return |\n {2}if \([^\n]*\) return /);
    if (!early) continue;

    const after = body.slice(early.index ?? 0);
    const found = [...after.matchAll(new RegExp(HOOK, 'g'))].map((m) => m[1]);
    if (found.length) {
      violations.push(`${path.relative(root, file)} :: ${name} -> ${[...new Set(found)].join(', ')}`);
    }
  }
}

check(`scanned ${scanned} components`, scanned > 40, `only ${scanned} - the walker may be missing files`);
check('no hook is called after an early return',
  violations.length === 0,
  violations.join(' | ') || 'React identifies hooks by call order; a conditional one changes the count between renders');

console.log('\n── the specific regression ────────────────────────────────────');

const receive = stripComments(fs.readFileSync(path.join(root, 'frontend/src/components/ReceiveView.tsx'), 'utf8'));
const firstGuard = receive.search(/\n {2}if \(!walletsEnabled\)/);
const lastHook = Math.max(
  receive.lastIndexOf('useState('),
  receive.lastIndexOf('useEffect('),
  receive.lastIndexOf('useMemo('),
);
check('ReceiveView has an early return to guard against', firstGuard > 0);
check('every hook in ReceiveView precedes it',
  lastHook > 0 && lastHook < firstGuard,
  'the wallet useMemo sat below three guards and crashed the screen');
check('the wallet lookup is a plain computation now',
  /const wallet =\s*\n?\s*openWallets\.find/.test(receive),
  'it never needed memoising - two scans over a list of length 2');
check('and it still matches by address family',
  receive.includes("walletFamily: string[] = activeChain === 'solana' ? ['solana'] : ['base', 'ethereum']"),
  'the fix must not undo the bug it was introduced to fix');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
