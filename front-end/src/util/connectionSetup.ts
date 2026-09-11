import type { ConnectionSetup } from '../types/ChiaGaming';

export type ConnectionSetupFlags = Pick<ConnectionSetup, 'skipQr' | 'fields'>;

/** WalletConnect pairing: show QR; do not finalize until the wallet scans. */
export function needsWalletPairing(setup: ConnectionSetupFlags): boolean {
  return !setup.skipQr && !setup.fields;
}

/**
 * skipQr + fields: collect values in ConnectionSetupModal before finalize
 * (Cloud Wallet OAuth). Silent reconnect and resume must not call finalize()
 * without those values — that would open an OAuth popup or fail with no client id.
 */
export function needsConnectionSetupPrompt(setup: ConnectionSetupFlags): boolean {
  return !!setup.fields && !!setup.skipQr;
}
