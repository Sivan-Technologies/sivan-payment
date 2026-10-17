import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// No backend application imports or provider access. Inspect executable string
// source lines rather than comments describing the historical build failure.
const root = process.cwd();
const forbidden = /(?:^|[/.\s])frontend\/(?:src|dist|node_modules|package)|--prefix\s+frontend\b|cd\s+frontend\b/;
const failures: string[] = [];
function inspect(name: string) {
  const source = fs.readFileSync(path.join(root, name), 'utf8');
  source.split('\n').forEach((line, index) => {
    if (!/^\s*(?:\/\/|\*|\/\*)/.test(line) && forbidden.test(line)) {
      failures.push(`${name}:${index + 1}`);
    }
  });
}
for (const file of fs.readdirSync(path.join(root, 'scripts'))) {
  // These guards mention forbidden paths to assert their absence; neither
  // loads browser code. The resolved TypeScript graph is checked separately.
  if (file === 'test-ci-coverage.ts' || file === 'test-frontend-retirement.ts') continue;
  if ((file.startsWith('test-') || file.startsWith('run-')) && file.endsWith('.ts')) inspect(`scripts/${file}`);
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const [name, command] of Object.entries(pkg.scripts as Record<string, string>)) {
  if (forbidden.test(command)) failures.push(`package.json:${name}`);
  for (const match of command.matchAll(/scripts\/[\w.-]+\.ts/g)) {
    assert.ok(fs.existsSync(path.join(root, match[0])), `${name} references missing ${match[0]}`);
  }
}
assert.deepEqual(failures, [], 'Active payment tests must not depend on the retired frontend');
console.log('Payment test entrypoints are independent of the legacy frontend.');
