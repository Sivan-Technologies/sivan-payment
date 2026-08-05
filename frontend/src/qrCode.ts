import qrcode from 'qrcode-generator';

/**
 * QR CODES, GENERATED LOCALLY.
 *
 * The Receive screen built its QR with:
 *
 *   `https://api.qrserver.com/v1/create-qr-code/?data=${address}`
 *
 * That sends every user's deposit address to a third party on every render.
 * A wallet address is not secret in the cryptographic sense, but handing an
 * outside service a live feed of "which address this product just issued, and
 * when" is a privacy leak we get nothing for. Worse, the QR - the safest way
 * to move an address between two phones, because it removes the clipboard
 * entirely - silently fails whenever that host is slow, blocked or down. For a
 * Nigerian user on a patchy connection that is not a rare case.
 *
 * WHY A LIBRARY AND NOT MY OWN ENCODER.
 *
 * I wrote one first. It produced a 33x33 matrix that looked plausible and was
 * WRONG: diffed against segno (a reference encoder) it had 272 incorrect
 * modules on a real Solana address - 104 in the data region and 13 in the
 * format bits. It would not have scanned, and on a deposit screen a QR that
 * silently encodes the wrong thing is the single most expensive bug available.
 *
 * qrcode-generator is dependency-free, has no build step and is the same
 * encoder behind most React QR components. Verified module-for-module against
 * segno for both address formats this product issues.
 */

/**
 * The QR as an inline SVG data URI.
 *
 * A data URI rather than <canvas>: no ref, no effect, no paint timing, it
 * survives being screenshotted or printed at any size, and there is no network
 * request to fail. One path of merged horizontal runs keeps the markup small.
 *
 * Error correction level M (~15%) rather than L: a phone camera reading a
 * screen at an angle, in Lagos daylight, on a cracked display, needs the
 * redundancy. The size cost is a few modules.
 */
export function qrDataUri(
  value: string,
  options: { dark?: string; light?: string; margin?: number } = {}
): string {
  const dark = options.dark ?? '#000000';
  const light = options.light ?? '#ffffff';
  // 4 modules is the quiet zone the spec requires. Cameras fail without it.
  const margin = options.margin ?? 4;

  // 0 = choose the smallest version that fits. Byte mode is implicit and is
  // what we need: base58 is case-sensitive, and QR's alphanumeric mode is
  // upper-case only, so encoding "EJJa" there would yield "EJJA" - a QR for a
  // DIFFERENT address.
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();

  const size = qr.getModuleCount();
  const full = size + margin * 2;

  let paths = '';
  for (let row = 0; row < size; row += 1) {
    let runStart = -1;
    for (let col = 0; col <= size; col += 1) {
      const isDark = col < size && qr.isDark(row, col);
      if (isDark && runStart === -1) runStart = col;
      if (!isDark && runStart !== -1) {
        const width = col - runStart;
        paths += `M${runStart + margin} ${row + margin}h${width}v1h-${width}z`;
        runStart = -1;
      }
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges">` +
    `<rect width="${full}" height="${full}" fill="${light}"/>` +
    `<path d="${paths}" fill="${dark}"/>` +
    `</svg>`;

  // encodeURIComponent rather than base64: the SVG is pure ASCII and base64
  // would inflate it by a third for nothing.
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Module grid, exposed so the encoder can be verified without a DOM. */
export function qrMatrix(value: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => qr.isDark(row, col))
  );
}
