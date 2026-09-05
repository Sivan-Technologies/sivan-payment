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
    // Three slanted bars, the Solana mark. Gradient because the brand is a
    // gradient and a flat purple reads as a different logo.
    return (
      <svg {...common}>
        <defs>
          <linearGradient id="sivan-sol" x1="0" y1="32" x2="32" y2="0">
            <stop offset="0%" stopColor="#9945FF" />
            <stop offset="100%" stopColor="#14F195" />
          </linearGradient>
        </defs>
        <path
          fill="url(#sivan-sol)"
          d="M6.5 21.3a1 1 0 0 1 .7-.3h18.1c.5 0 .8.6.4 1l-3.6 3.6a1 1 0 0 1-.7.3H3.3c-.5 0-.8-.6-.4-1zM6.5 6.4a1 1 0 0 1 .7-.3h18.1c.5 0 .8.6.4 1l-3.6 3.6a1 1 0 0 1-.7.3H3.3c-.5 0-.8-.6-.4-1zM22.1 13.8a1 1 0 0 0-.7-.3H3.3c-.5 0-.8.6-.4 1l3.6 3.6a1 1 0 0 0 .7.3h18.1c.5 0 .8-.6.4-1z"
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
