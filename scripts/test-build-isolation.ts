/**
 * THE PRODUCTION API BUILD MUST NOT READ FRONTEND SOURCE.
 *
 * This suite exists because of a live deploy failure:
 *
 *   frontend/src/qrCode.ts(1,20): error TS2307:
 *     Cannot find module 'qrcode-generator'
 *   ==> Build failed
 *
 * tsconfig.json included `scripts/**\/*.ts`. 23 test scripts import frontend
 * modules directly, so the API's compilation graph quietly contained 8
 * frontend files. Seven had no external imports and it worked by accident.
 * The moment qrCode.ts took a dependency that lives in frontend/package.json,
 * the API build - which only ever runs `npm install` at the repo ROOT - could
 * not resolve it, and production stopped building.
 *
 * The failure mode is nasty for two reasons:
 *
 *   1. It is invisible locally. Any developer who has run the frontend once
 *      has frontend/node_modules on disk, so tsc resolves the import and the
 *      build is green. It only fails on a clean checkout, which is to say:
 *      only on Render, only on deploy.
 *
 *   2. It is a frontend change breaking a backend deploy, so nobody looks in
 *      the right place.
 *
 * So the guard checks the real compilation graph, not the config text. A
 * config can be rewritten a dozen ways that all reintroduce the bug; there is
 * only one thing that actually matters, which is whether a frontend file ends
 * up in the API's file list.
 *
 * MUTATION-TESTED. Putting "scripts/**\/*.ts" back into tsconfig.json must
 * fail tests here, or this file is decorative.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}\n    ${(error as Error).message}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const tsc = path.join(root, 'node_modules', '.bin', 'tsc');

/** The files tsc will actually read for a given config, minus dependencies. */
function projectFiles(config: string): string[] {
  const out = execFileSync(tsc, ['-p', config, '--listFiles', '--noEmit'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !file.includes('/node_modules/'));
}

// ---------------------------------------------------------------------------
// 1. The graph itself. This is the assertion that would have caught the outage.
// ---------------------------------------------------------------------------

const apiFiles = projectFiles('tsconfig.json');

check('API build graph contains no frontend source', () => {
  const leaked = apiFiles.filter((file) => file.includes(`${path.sep}frontend${path.sep}`));
  assert(
    leaked.length === 0,
    `${leaked.length} frontend file(s) are compiled into the production API build:\n` +
      leaked.map((f) => `      ${path.relative(root, f)}`).join('\n') +
      '\n    These resolve against frontend/node_modules, which Render never installs ' +
      'for the API service.',
  );
});

check('API build graph contains no test scripts', () => {
  const leaked = apiFiles.filter((file) => file.includes(`${path.sep}scripts${path.sep}`));
  assert(
    leaked.length === 0,
    `${leaked.length} script(s) are compiled into the production API build, ` +
      'which is how frontend source got pulled in:\n' +
      leaked.slice(0, 8).map((f) => `      ${path.relative(root, f)}`).join('\n'),
  );
});

check('API build graph is non-empty and does contain src', () => {
  // Guards against the lazy "fix" of emptying the include list, which would
  // make every assertion above pass and ship nothing.
  const srcFiles = apiFiles.filter((file) => file.includes(`${path.sep}src${path.sep}`));
  assert(srcFiles.length > 50, `expected the API build to compile src, saw ${srcFiles.length} files`);
});

check('API build still emits the entrypoint package.json start depends on', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const start: string = pkg.scripts.start;
  const match = start.match(/dist\/\S+\.js/);
  assert(match, `could not find a dist entrypoint in start script: ${start}`);
  const entry = match[0].replace('dist/', '').replace(/\.js$/, '.ts');
  assert(
    apiFiles.some((file) => file.endsWith(entry)),
    `start runs ${match[0]} but ${entry} is not in the build graph - npm start would fail`,
  );
});

// ---------------------------------------------------------------------------
// 2. The dependency direction. The backend must not acquire frontend packages
//    as a workaround for the above.
// ---------------------------------------------------------------------------

check('backend does not depend on frontend-only packages', () => {
  const backend = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const deps = { ...(backend.dependencies ?? {}), ...(backend.devDependencies ?? {}) };
  // qrcode-generator is a browser QR renderer. The API never draws a QR.
  // Adding it here makes the build pass while leaving the real coupling in
  // place, so the next frontend-only dependency breaks production identically.
  for (const forbidden of ['qrcode-generator', 'react', 'react-dom', 'vite']) {
    assert(
      !(forbidden in deps),
      `backend package.json depends on '${forbidden}', a frontend package. ` +
        'If this was added to make the API build resolve a frontend import, ' +
        'the import is the bug - remove it from the API build graph instead.',
    );
  }
});

check('frontend declares the packages its own source imports', () => {
  const fe = JSON.parse(readFileSync(path.join(root, 'frontend', 'package.json'), 'utf8'));
  const deps = { ...(fe.dependencies ?? {}), ...(fe.devDependencies ?? {}) };
  assert(
    'qrcode-generator' in deps,
    'frontend/src/qrCode.ts imports qrcode-generator but frontend/package.json ' +
      'does not declare it - the frontend static build would fail',
  );
});

check('frontend lockfile pins qrcode-generator', () => {
  // `npm install` on Render uses the lockfile. A dependency present in
  // package.json but absent from the lock is a build failure on a clean box.
  const lock = readFileSync(path.join(root, 'frontend', 'package-lock.json'), 'utf8');
  assert(
    lock.includes('node_modules/qrcode-generator'),
    'frontend/package-lock.json has no qrcode-generator entry - run npm install and commit the lock',
  );
});

// ---------------------------------------------------------------------------
// 3. Scripts are still typechecked. Removing them from the shipped build must
//    not mean nobody checks them.
// ---------------------------------------------------------------------------

check('a scripts typecheck config exists and covers the test scripts', () => {
  const configPath = path.join(root, 'tsconfig.scripts.json');
  assert(existsSync(configPath), 'tsconfig.scripts.json is missing - test scripts are unchecked');

  const scriptFiles = projectFiles('tsconfig.scripts.json').filter((file) =>
    file.includes(`${path.sep}scripts${path.sep}`),
  );
  assert(scriptFiles.length > 20, `expected the scripts config to check the test scripts, saw ${scriptFiles.length}`);
});

check('the scripts typecheck config does see frontend source', () => {
  // The scripts assert against real frontend modules. If this config stopped
  // resolving them the checks would pass vacuously.
  const feFiles = projectFiles('tsconfig.scripts.json').filter((file) =>
    file.includes(`${path.sep}frontend${path.sep}`),
  );
  assert(feFiles.length > 0, 'the scripts config resolves no frontend source, so it is not checking what the tests import');
});

check('npm run typecheck runs both configs', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const typecheck: string = pkg.scripts.typecheck ?? '';
  assert(typecheck.includes('tsconfig.json'), `typecheck does not check the API build: ${typecheck}`);
  assert(
    typecheck.includes('tsconfig.scripts.json'),
    `typecheck does not check the test scripts, so a type error in them reaches main: ${typecheck}`,
  );
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\nbuild-isolation: ${passed} passed, ${failures.length} FAILED\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}\n`);
  process.exit(1);
}

console.log(`build-isolation: ${passed} checks passed`);
