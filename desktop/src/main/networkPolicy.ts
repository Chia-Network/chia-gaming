import type { DesktopConfig } from './config';

/**
 * Endpoints reachable by `@walletconnect/sign-client` 2.23. Both hostnames are
 * live: `front-end/src/constants/env.ts` pins the `.com` relay while the
 * library's own defaults point at `.org`.
 */
const WALLET_CONNECT_REQUEST_ORIGINS = [
  'wss://relay.walletconnect.com',
  'wss://relay.walletconnect.org',
  'https://verify.walletconnect.com',
  'https://verify.walletconnect.org',
  'https://pulse.walletconnect.org',
];

/** The Verify API renders an attestation iframe inside the player document. */
const WALLET_CONNECT_FRAME_ORIGINS = [
  'https://verify.walletconnect.com',
  'https://verify.walletconnect.org',
];

export type NetworkPolicy = {
  /** Origins the app may open network connections to. Everything else is cancelled. */
  allowedRequestOrigins: ReadonlySet<string>;
  /** Origins allowed to load as a sub-frame of the player document. */
  allowedFrameOrigins: ReadonlySet<string>;
  contentSecurityPolicy: string;
};

/**
 * The policy is held behind a mutable reference because approving a hub at
 * runtime widens it. Every consumer reads `current` at the moment it makes a
 * decision — per request, per navigation, per document served — so a newly
 * trusted origin takes effect without restarting the app.
 */
export type PolicyRef = { current: NetworkPolicy };

export function originOfUrl(value: string): string | null {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** `HubConnection` derives its WebSocket URL from the hub origin the same way. */
function webSocketOrigin(httpOrigin: string): string {
  const url = new URL(httpOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.origin;
}

function buildContentSecurityPolicy(
  requestOrigins: readonly string[],
  frameOrigins: readonly string[],
): string {
  return [
    "default-src 'none'",
    // 'wasm-unsafe-eval' lets the Rust engine compile. JS eval stays blocked.
    "script-src 'self' 'wasm-unsafe-eval'",
    // Radix's scroll-lock injects a <style> element at runtime.
    "style-src 'self' 'unsafe-inline'",
    // data: for generated WalletConnect QR codes.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${requestOrigins.join(' ')}`,
    `frame-src ${frameOrigins.join(' ')}`,
    "worker-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function buildNetworkPolicy(config: DesktopConfig): NetworkPolicy {
  const requestOrigins = [
    ...config.hubOrigins,
    ...config.hubOrigins.map(webSocketOrigin),
    ...WALLET_CONNECT_REQUEST_ORIGINS,
  ];
  const frameOrigins = [...config.hubOrigins, ...WALLET_CONNECT_FRAME_ORIGINS];

  const uniqueRequestOrigins = [...new Set(requestOrigins)].sort();
  const uniqueFrameOrigins = [...new Set(frameOrigins)].sort();

  return {
    allowedRequestOrigins: new Set(uniqueRequestOrigins),
    allowedFrameOrigins: new Set(uniqueFrameOrigins),
    contentSecurityPolicy: buildContentSecurityPolicy(uniqueRequestOrigins, uniqueFrameOrigins),
  };
}
