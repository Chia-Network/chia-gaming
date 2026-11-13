import type { DurableSessionPhase } from '../lib/session/saveEnvelope';
import type { SessionPhase } from '../types/ChiaGaming';

export type WalletSwitchState = {
  sessionPhase: SessionPhase;
  /** The saved session, which can await resume while `sessionPhase` is still `none`. */
  durableSession: Pick<DurableSessionPhase, 'phase'> | null;
  hasPairingToken: boolean;
  /**
   * Accept has started a session but not yet saved it. Starting captures the
   * current wallet before awaiting, so `sessionPhase` and the save both still
   * look idle while the session is already bound to that wallet.
   */
  acceptInFlight: boolean;
  /** A connect or switch is already running. */
  busy: boolean;
};

/**
 * Channel funding and fee reservations belong to the wallet that made them,
 * so the wallet changes only with no session starting, live, or saved to
 * resume: the same saved sessions that keep a wallet disconnect resumable. A
 * terminal save holds no funds and does not block.
 */
export function canSwitchWallet(state: WalletSwitchState): boolean {
  const phase = state.durableSession?.phase;
  return (
    !state.busy &&
    !state.acceptInFlight &&
    state.sessionPhase === 'none' &&
    phase !== 'live' &&
    phase !== 'pre-handshake' &&
    !state.hasPairingToken
  );
}
