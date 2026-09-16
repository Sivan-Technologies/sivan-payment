/**
 * NETWORK LOGOS, INLINE.
 *
 * Drawn as SVG paths in the bundle rather than fetched from a CDN or a token
 * list, for the same reason the QR is generated locally: this is the screen
 * where a user decides which chain to send real money on, and a logo that
 * fails to load leaves two unlabelled rows that look interchangeable. A
 * network mark is also the fastest thing a person recognises - faster than
 * reading "Base" - so it must not depend on someone else's uptime.
 *
 * Each mark is the official brand geometry, simplified to a single path where
 * possible and rendered in the chain's own colour. `currentColor` is not used:
 * these are brand identities, and recolouring them to match our theme would
 * make Base and Ethereum look like the same network, which is precisely the
 * confusion this screen exists to prevent.
 */

export type LogoChain = 'solana' | 'base' | 'ethereum' | 'stellar' | 'celo' | 'polygon' | 'arbitrum' | 'bsc';

/**
 * Is there a real mark for this chain string?
 */
export function logoChainFor(chain?: string): LogoChain | undefined {
  const key = String(chain ?? '').trim().toLowerCase();
  const valid: LogoChain[] = ['solana', 'base', 'ethereum', 'stellar', 'celo', 'polygon', 'arbitrum', 'bsc'];
  return valid.includes(key as LogoChain) ? (key as LogoChain) : undefined;
}

export function NetworkLogo({ chain, size = 20 }: { chain: LogoChain; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 32 32',
    'aria-hidden': true as const,
    focusable: 'false' as const,
  };

  if (chain === 'solana') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 640 640"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id="sivan-sol" x1="0" y1="640" x2="640" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#9945FF" />
            <stop offset="100%" stopColor="#14F195" />
          </linearGradient>
        </defs>
        <path
          fill="url(#sivan-sol)"
          d="M574.5 449.2L489.6 537.9C487.8 539.8 485.5 541.4 483 542.4C480.5 543.4 477.8 544 475.1 544L72.9 544C71 544 69.1 543.5 67.5 542.4C65.9 541.3 64.6 539.9 63.9 538.2C63.2 536.5 62.9 534.6 63.2 532.7C63.5 530.8 64.4 529.1 65.7 527.8L150.6 439.1C152.4 437.2 154.7 435.6 157.1 434.6C159.5 433.6 162.2 433 164.9 433L567.3 433C569.2 433 571.1 433.5 572.7 434.6C574.3 435.7 575.6 437.1 576.3 438.8C577 440.5 577.3 442.4 577 444.3C576.7 446.2 575.8 447.9 574.5 449.2zM489.7 270.6C487.9 268.7 485.6 267.1 483.1 266.1C480.6 265.1 477.9 264.5 475.2 264.5L72.8 264.5C70.9 264.5 69 265 67.4 266.1C65.8 267.2 64.5 268.6 63.8 270.3C63.1 272 62.8 273.9 63.1 275.8C63.4 277.7 64.3 279.4 65.6 280.7L150.5 369.4C152.3 371.3 154.6 372.9 157 373.9C159.4 374.9 162.1 375.5 164.8 375.5L567.2 375.5C569.1 375.5 571 375 572.6 373.9C574.2 372.8 575.5 371.4 576.2 369.7C576.9 368 577.2 366.1 576.9 364.2C576.6 362.3 575.7 360.6 574.4 359.3L489.5 270.6zM72.9 206.9L475.3 206.9C478 206.9 480.7 206.4 483.2 205.3C485.7 204.2 487.9 202.7 489.8 200.8L574.7 112.1C576 110.7 576.9 109 577.2 107.2C577.5 105.4 577.3 103.5 576.5 101.7C575.7 99.9 574.5 98.5 572.9 97.5C571.3 96.5 569.4 95.9 567.5 95.9L165 96C162.3 96 159.6 96.5 157.2 97.6C154.8 98.7 152.5 100.2 150.7 102.1L65.7 190.8C64.4 192.2 63.5 193.9 63.2 195.7C62.9 197.5 63.1 199.4 63.9 201.2C64.7 203 65.9 204.4 67.5 205.4C69.1 206.4 71 207 72.9 207z"
        />
      </svg>
    );
  }

  if (chain === 'base') {
    return (
      <svg {...common}>
        <path
          fill="#0052FF"
          d="M16 32c8.837 0 16-7.163 16-16S24.837 0 16 0C7.616 0 .744 6.451.052 14.657h21.16v2.686H.052C.744 25.549 7.616 32 16 32z"
        />
      </svg>
    );
  }

  if (chain === 'stellar') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="50" cy="50" r="48" fill="#000000" />
        <g fill="#FFFFFF" fillRule="evenodd">
          <path d="M50 18c-14.8 0-27.2 10.1-30.7 23.9l7-4.2C28.8 28.1 38.6 24 50 24c13.2 0 24.2 9.8 25.8 22.8l7-4.2C80.8 27.6 66.8 18 50 18z" />
          <path d="M50 82c14.8 0 27.2-10.1 30.7-23.9l-7 4.2C71.2 71.9 61.4 76 50 76c-13.2 0-24.2-9.8-25.8-22.8l-7 4.2C19.2 72.4 33.2 82 50 82z" />
          <path d="M12.5 56.5L87.5 11.5v6.5L12.5 63z" />
          <path d="M12.5 76.5L87.5 31.5v6.5L12.5 83z" />
        </g>
      </svg>
    );
  }

  if (chain === 'celo') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 2500 2500"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="1250" cy="1250" r="1250" fill="#FCFF52" />
        <path
          fill="#1E1E1E"
          fillRule="evenodd"
          clipRule="evenodd"
          d="M1949.3 546.2H550.7v1407.7h1398.7v-491.4h-232.1c-80 179.3-260.1 304.1-466.2 304.1-284.1 0-514.2-233.6-514.2-517.5 0-284 230.1-515.6 514.2-515.6 210.1 0 390.2 128.9 470.2 312.1h228.1V546.2z"
        />
      </svg>
    );
  }

  if (chain === 'polygon') {
    return (
      <svg {...common} viewBox="0 0 32 32">
        <circle cx="16" cy="16" r="15" fill="#8247E5" />
        <path fill="#fff" d="M16 8l6 3.5v7L16 22l-6-3.5v-7L16 8zm0 3.2L12.5 13v4l3.5 1.8 3.5-1.8v-4L16 11.2z" />
      </svg>
    );
  }

  if (chain === 'arbitrum') {
    return (
      <svg {...common} viewBox="0 0 32 32">
        <circle cx="16" cy="16" r="15" fill="#28A0F0" />
        <path fill="#fff" d="M16 7l8 14h-4.2l-3.8-6.6-3.8 6.6H8l8-14zm0 5.2L13 18h6l-3-5.8z" />
      </svg>
    );
  }

  if (chain === 'bsc') {
    return (
      <svg {...common} viewBox="0 0 32 32">
        <circle cx="16" cy="16" r="15" fill="#F0B90B" />
        <path fill="#fff" d="M16 8l3 3-4.5 4.5 4.5 4.5-3 3-7.5-7.5L16 8zm4.5 4.5l3 3-3 3-3-3 3-3z" />
      </svg>
    );
  }

  // Ethereum: the two-tone octahedron.
  return (
    <svg {...common}>
      <circle cx="16" cy="16" r="16" fill="#627EEA" />
      <path fill="#fff" fillOpacity=".6" d="M16.1 5v8.1l6.9 3.1z" />
      <path fill="#fff" d="M16.1 5 9.2 16.2l6.9-3.1z" />
      <path fill="#fff" fillOpacity=".6" d="M16.1 21.5V27l6.9-9.5z" />
      <path fill="#fff" d="M16.1 27v-5.5L9.2 17.5z" />
      <path fill="#fff" fillOpacity=".2" d="m16.1 20.2 6.9-4-6.9-3.1z" />
      <path fill="#fff" fillOpacity=".6" d="m9.2 16.2 6.9 4v-7.1z" />
    </svg>
  );
}

/**
 * The mark for a FAMILY row.
 *
 * A family with more than one chain shows both marks overlapped, because the
 * row genuinely represents two networks and showing only the first would
 * misrepresent it - a user scanning for Ethereum needs to see it is in there.
 */
export function NetworkFamilyLogo({ chains, size = 20 }: { chains: LogoChain[]; size?: number }) {
  if (chains.length === 1) return <NetworkLogo chain={chains[0]} size={size} />;

  return (
    <span className="network-logo-stack" style={{ height: size }}>
      {chains.map((chain, index) => (
        <span
          key={chain}
          className="network-logo-stack-item"
          /**
           * Overlap by a QUARTER, not a third.
           *
           * At a third the second mark was nearly unreadable in the render -
           * the Ethereum diamond sat mostly behind the Base circle and the row
           * looked like one logo with a smudge. The point of stacking is that
           * a user scanning for Ethereum can see it is in this family, so the
           * second mark has to stay identifiable.
           *
           * zIndex descends so the FIRST chain sits on top: it is the default
           * member and the one the sub-choice preselects.
           */
          style={{ marginLeft: index === 0 ? 0 : -size / 4, zIndex: chains.length - index }}
        >
          <NetworkLogo chain={chain} size={size} />
        </span>
      ))}
    </span>
  );
}
