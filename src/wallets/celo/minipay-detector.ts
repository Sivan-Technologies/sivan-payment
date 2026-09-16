/**
 * MiniPay Mobile Provider Detection Layer
 *
 * Auto-detects Opera MiniPay's injected Ethereum-compatible provider
 * inside the mobile WebView environment.
 *
 * When loaded inside MiniPay:
 * - window.ethereum.isMiniPay === true
 * - Wallet connection prompts are suppressed (auto-connected)
 * - User's Celo address is available directly from the provider
 * - Celo fee abstraction is natively supported
 *
 * This module is safe to import in Node.js environments (server-side)
 * where it will return false for all detection checks.
 *
 * ERC-8021 Attribution: Every transaction originating from the Mini App
 * must append the Sivan attribution suffix (celo_bafcc2e56bd7).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MiniPayDetectionResult {
  /** Whether the current environment is MiniPay */
  isMiniPay: boolean;
  /** The user's injected Celo address (null if not in MiniPay) */
  address: string | null;
  /** Chain ID reported by the provider (42220 = Celo Mainnet) */
  chainId: number | null;
  /** Whether fee abstraction is available */
  feeAbstractionSupported: boolean;
}

export interface MiniPayCapabilities {
  /** MiniPay supports cUSD, USDC, USDT natively */
  supportedTokens: string[];
  /** Whether the provider can sign transactions without user prompt */
  autoSign: boolean;
  /** Maximum recommended gas limit for MiniPay transactions */
  maxGasLimit: number;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Checks if the current runtime environment is inside Opera MiniPay.
 *
 * Safe to call in Node.js (always returns false).
 * In the browser, checks window.ethereum.isMiniPay.
 */
export function isMiniPayEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof (window as any).ethereum === 'undefined') return false;
  return (window as any).ethereum?.isMiniPay === true;
}

/**
 * Detects the MiniPay environment and retrieves the connected wallet info.
 *
 * Returns a complete detection result including the user's auto-connected
 * Celo address. No manual wallet connection prompt is needed inside MiniPay.
 */
export async function detectMiniPay(): Promise<MiniPayDetectionResult> {
  if (!isMiniPayEnvironment()) {
    return {
      isMiniPay: false,
      address: null,
      chainId: null,
      feeAbstractionSupported: false,
    };
  }

  const provider = (window as any).ethereum;

  try {
    // MiniPay auto-connects; request accounts to get the address
    const accounts: string[] = await provider.request({
      method: 'eth_requestAccounts',
    });

    const chainIdHex: string = await provider.request({
      method: 'eth_chainId',
    });

    const chainId = parseInt(chainIdHex, 16);
    const address = accounts[0] || null;

    return {
      isMiniPay: true,
      address,
      chainId,
      // Celo Mainnet (42220) supports fee abstraction natively
      feeAbstractionSupported: chainId === 42220,
    };
  } catch (err) {
    // Detection succeeded but account retrieval failed
    return {
      isMiniPay: true,
      address: null,
      chainId: null,
      feeAbstractionSupported: false,
    };
  }
}

/**
 * Returns MiniPay-specific capabilities and constraints.
 *
 * Use this to configure the Mini App UI behavior:
 * - Which tokens to display
 * - Whether to show manual wallet connect buttons
 * - Gas limit ceilings for transaction construction
 */
export function getMiniPayCapabilities(): MiniPayCapabilities {
  return {
    supportedTokens: ['cUSD', 'USDC', 'USDT', 'cNGN'],
    autoSign: true,
    maxGasLimit: 500_000,
  };
}

/**
 * Requests MiniPay to switch to Celo Mainnet if not already connected.
 *
 * MiniPay typically defaults to Celo Mainnet, but this ensures correct
 * chain configuration for edge cases.
 */
export async function ensureCeloMainnet(): Promise<boolean> {
  if (!isMiniPayEnvironment()) return false;

  const provider = (window as any).ethereum;

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0xa4ec' }], // 42220 in hex
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks if the user agent indicates a MiniPay WebView.
 * Fallback detection when window.ethereum is not yet injected.
 */
export function isMiniPayUserAgent(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes('minipay') || ua.includes('opera mini');
}
