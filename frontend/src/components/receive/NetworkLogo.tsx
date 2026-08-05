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

export type LogoChain = 'solana' | 'base' | 'ethereum';

export function NetworkLogo({ chain, size = 20 }: { chain: LogoChain; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 32 32',
    // Decorative: the network name is always adjacent in text, so announcing
    // the logo too would make a screen reader say "Base Base".
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
    // A circle with a square notch cut from the right - the Base mark.
    return (
      <svg {...common}>
        <circle cx="16" cy="16" r="16" fill="#0052FF" />
        <path
          fill="#fff"
          d="M15.9 27.2c6.2 0 11.2-5 11.2-11.2S22.1 4.8 15.9 4.8C10 4.8 5.2 9.3 4.7 15h14.9v2H4.7c.5 5.7 5.3 10.2 11.2 10.2z"
        />
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
