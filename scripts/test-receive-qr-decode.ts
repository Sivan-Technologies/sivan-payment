/**
 * THE QR MUST DECODE BACK TO THE EXACT ADDRESS.
 *
 * This is the only assertion on the Receive screen that genuinely matters, and
 * it exists because I got it wrong. My first encoder was hand-written and
 * produced a matrix that LOOKED like a QR - correct size, right finder
 * patterns - but diffed 272 modules against a reference encoder. It would not
 * have scanned, and a QR that silently encodes the wrong address on a deposit
 * screen is the most expensive bug this product could ship.
 *
 * Structural checks cannot catch that. Nothing short of decoding the rendered
 * image proves the thing works, so this writes a real PNG and reads it back
 * with OpenCV's QR detector - the same class of decoder a phone camera uses.
 *
 * Run: npm run test:receive-qr-decode   (requires python3 + opencv)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { qrDataUri, qrMatrix } from '../frontend/src/qrCode.js';

const ADDRESSES = [
  // Real addresses this product has issued, all three formats.
  'EJJaFs7u3QyTAREDsAW7RCK4KeSTtBwujnrqKDGfJzZp',
  'AVXsBHMhRtc5LqoLTvaQBX7oUayS4f3h1TrATUX1v7Df',
  '0x6d7D2Eb4667395437739634D3382A90Fff238295',
  // Mixed case matters: alphanumeric QR mode is upper-case only, so an encoder
  // that silently used it would turn this into a DIFFERENT address.
  '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01',
];

const DECODER = `
import sys, numpy as np, cv2
addr = sys.argv[1]
rows = [l for l in open(sys.argv[2]).read().strip().split('\\n') if l and set(l) <= {'0','1'}]
n = len(rows); M, S = 4, 12
full = (n + 2*M) * S
img = np.full((full, full), 255, np.uint8)
for r in range(n):
    for c in range(n):
        if rows[r][c] == '1':
            img[(r+M)*S:(r+M)*S+S, (c+M)*S:(c+M)*S+S] = 0
data, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
print(data)
`;

let pass = 0;
let fail = 0;
fs.writeFileSync('/tmp/_qrdec.py', DECODER);

for (const address of ADDRESSES) {
  /**
   * DECODE THE FUNCTION THE UI ACTUALLY CALLS.
   *
   * This tested qrMatrix() while ReceiveView renders qrDataUri(). Both call
   * addData separately, so a mutation inside qrDataUri - the shipped path -
   * left the test green. Found by mutating and watching it pass: upper-casing
   * the value inside qrDataUri encodes a DIFFERENT base58 address and nothing
   * failed.
   *
   * The SVG is parsed back into a module grid so the rendered artefact is what
   * gets decoded, not a parallel code path that merely agrees with it.
   */
  const uri = qrDataUri(address, { margin: 0 });
  const svg = decodeURIComponent(uri.replace('data:image/svg+xml,', ''));
  const viewBox = /viewBox="0 0 (\d+) /.exec(svg);
  const side = viewBox ? Number(viewBox[1]) : 0;
  const runs = [...svg.matchAll(/M(\d+) (\d+)h(\d+)/g)];
  const matrix: boolean[][] = Array.from({ length: side }, () => new Array(side).fill(false));
  for (const [, x, y, w] of runs) {
    for (let i = 0; i < Number(w); i += 1) matrix[Number(y)][Number(x) + i] = true;
  }
  // Cross-check the two entry points agree, so neither can drift unnoticed.
  const gridMatrix = qrMatrix(address);
  if (JSON.stringify(gridMatrix) !== JSON.stringify(matrix)) {
    console.log(`  FAIL ${address} -> qrDataUri and qrMatrix disagree`);
    fail += 1;
    continue;
  }
  fs.writeFileSync('/tmp/_qrmat.txt', matrix.map((r) => r.map((c) => (c ? '1' : '0')).join('')).join('\n'));
  /**
   * The decoder PRINTS what it read, and the comparison happens here against
   * the original address.
   *
   * Caught by mutation: when python did the comparison it was handed the same
   * (already mutated) address the encoder used, so upper-casing the value
   * inside the encoder still "passed" - self-consistent, and a wrong address.
   * A base58 string differs from its upper-cased form and belongs to someone
   * else entirely.
   */
  let decoded = '';
  try {
    decoded = execFileSync('python3', ['/tmp/_qrdec.py', address, '/tmp/_qrmat.txt'], { encoding: 'utf8' }).replace(/\n$/, '');
  } catch (error) {
    decoded = `<decoder error: ${error instanceof Error ? error.message : String(error)}>`;
  }
  const ok = decoded === address;
  const result = ok ? 'OK' : `decoded ${JSON.stringify(decoded)}`;
  if (ok) { pass += 1; console.log(`  ok   ${address.slice(0, 16)}… decodes back exactly (${matrix.length}x${matrix.length})`); }
  else { fail += 1; console.log(`  FAIL ${address} -> ${result}`); }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
