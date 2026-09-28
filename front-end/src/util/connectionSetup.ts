import type { ConnectionSetup } from '../types/ChiaGaming';

export type ConnectionSetupFlags = Pick<ConnectionSetup, 'skipQr' | 'fields'>;

/** WalletConnect pairing: show QR; do not finalize until the wallet scans. */
export function needsWalletPairing(setup: ConnectionSetupFlags): boolean {
  return !setup.skipQr && !setup.fields;
}

/**
 * skipQr + fields: show ConnectionSetupModal before finalize (Cloud Wallet
 * OAuth, possibly with no fields). Silent reconnect and resume must not call
 * finalize() without that user click — it would open an OAuth popup unprompted.
 */
export function needsConnectionSetupPrompt(setup: ConnectionSetupFlags): boolean {
  return !!setup.fields && !!setup.skipQr;
}
