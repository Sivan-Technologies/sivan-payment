// Decorative colour emoji must not return to the UI.
//
// The landing feature grid mixed four colour emoji with two monochrome
// glyphs, so the row read as inconsistent -- part sticker sheet, part icon
// set. Monochrome glyphs are fine: they inherit currentColor and sit in the
// palette. Colour emoji are rendered by the OS font and cannot be themed,
// so they always look pasted on.
//
// Genuine data is exempt: a country flag is content, not decoration.
import fs from 'fs';
import path from 'path';

const ROOT = '/home/user/sivan-payment/frontend/src';
// U+1F300-1FAFF misses the Miscellaneous Symbols block, where the original
// offender lived: ⚡ is U+26A1. Listed explicitly rather than sweeping all of
// 2600-27BF, because that block also holds the monochrome glyphs the UI uses
// deliberately (✓ ✉ ⚙ ⚠ ♢).
// U+1F300-1FAFF misses the Miscellaneous Symbols block, where the original
// offender lived: ⚡ is U+26A1.
//
// Listed explicitly rather than sweeping 2600-27BF, because that block also
// holds glyphs the UI uses ON PURPOSE and which render monochrome, inheriting
// currentColor: ✓ ✉ ⚙ ⚠ ♢ ✦. A first pass banned ⚠ too and flagged the test
// environment banner and the incident feed, both of which are correct as-is.
// Only codepoints that browsers render in COLOUR by default are listed.
const COLOUR_EMOJI = /[\u{1F300}-\u{1FAFF}]|[\u26A1\u2705\u274C\u2B50\u26D4\u2764\u2728]|\uFE0F/u;
// Regional-indicator pairs form flag emoji; those are data.
const FLAG = /[\u{1F1E6}-\u{1F1FF}]/u;
const ALLOW = [
  // Country-flag fallback in the verification modal: it stands in for real
  // flag data when a country is unknown, so it is content.
  'components/verification/VerificationModal.tsx',
];

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  return e.isDirectory() ? walk(full) : (/\.tsx?$/.test(e.name) ? [full] : []);
});

let bad = [];
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file);
  if (ALLOW.includes(rel)) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (FLAG.test(line)) return;
    const m = line.match(COLOUR_EMOJI);
    if (m) bad.push(`${rel}:${i + 1}  ${m[0]}  ${line.trim().slice(0, 60)}`);
  });
}
if (bad.length) {
  console.log('FAIL  decorative colour emoji found:');
  bad.forEach((b) => console.log('   ', b));
} else {
  console.log('PASS  no decorative colour emoji in the UI');
}
process.exit(bad.length ? 1 : 0);
