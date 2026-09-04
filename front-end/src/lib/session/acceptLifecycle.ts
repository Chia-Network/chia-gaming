/**
 * Accept lifecycle: peer consent → live checkpoint → GameSession mount.
 *
 * Owns freeze-safe disposition for Cancel / peer reject / delivery failure /
 * remap during Accept. Failures before replaceSession lands abandon the peer
 * attempt only; after the write, full attempt teardown is required.
 */

import type {
  SessionHistorySave,
  SessionIdentitySave,
  SessionPairingSave,
  SessionPresentationSave,
  SessionSave,
  SessionTransportSave,
  TerminalSessionSave,
} from './saveEnvelope';
import type { ChannelStatus } from '../../types/ChiaGaming';
import type { SessionModel } from './types';

export type AcceptPhase = 'idle' | 'accepting' | 'persistDraining' | 'liveMounting' | 'active';

export type AcceptReason = 'accept-advisory' | 'accept-proposal';

export type StartFailureDisposition = 'abandon-peer-only' | 'cancel-attempt';

/** Single setup copy for Accept session-pane covers. */
export const ACCEPT_SETTING_UP_COPY = 'Setting up channel…';

/**
 * Channel states whose dashboard action is still Cancel during Accept setup.
 * Leaving these (or never entering them) means the session-pane cover can drop.
 */
export const ACCEPT_SETUP_CANCEL_CHANNEL_STATES = new Set<ChannelStatus>([
  'Handshaking',
  'WaitingForHeightToOffer',
  'WaitingForHeightToAccept',
  'OurWalletMakingOffer',
  'OurWalletMakingOfferAcceptance',
]);

/**
 * After Accept, `transitionToFreshSession` only retires the finished freeze once
 * the live checkpoint write has landed. Failures or user Cancel before that must
 * end the peer attempt only — never clear IndexedDB / blank results. Once
 * replaceSession has successfully replaced the checkpoint, full attempt teardown
 * is required.
 */
export function startFailureDisposition(persistCommitted: boolean): StartFailureDisposition {
  return persistCommitted ? 'cancel-attempt' : 'abandon-peer-only';
}

/**
 * `setupPending` covers only the pre-first-model gap (and a finished freeze still
 * mounted until retireTerminalDisplay). Once a live SessionModel exists, dashboard
 * labels must be core-derived even while the session-pane transition remains
 * pending through handshake Cancel states.
 */
export function shouldSynthesizeSetupPending(
  sessionPaneTransition: boolean,
  hasLiveSessionModel: boolean,
): boolean {
  return sessionPaneTransition && !hasLiveSessionModel;
}

/**
 * Explicit ready predicate for completing an Accept session-pane transition.
 * True once the projected channel has left Cancel-only setup states.
 */
export function shouldCompleteAcceptTransition(model: SessionModel): boolean {
  return !ACCEPT_SETUP_CANCEL_CHANNEL_STATES.has(model.channel.status.state);
}

export type TerminalSessionBackup = {
  terminal: TerminalSessionSave['terminal'];
  presentation: SessionPresentationSave;
} | null;

export type FreshStartCheckpoint = {
  pairing: SessionPairingSave;
  transport: SessionTransportSave;
  identity?: Partial<SessionIdentitySave>;
  history?: Partial<SessionHistorySave>;
};

/**
 * Persist the pre-cradle live checkpoint for a fresh Accept start.
 * Backs up a finished terminal envelope from `loadState()` so Cancel mid-write
 * can restore the freeze rather than leaving preferences-only IndexedDB under
 * a still-visible results UI. `onCommitted` runs as soon as `replaceSession`
 * lands so a later restore failure still takes full-attempt teardown disposition.
 */
export async function persistFreshStartCheckpoint(args: {
  epoch: number;
  getCurrentEpoch: () => number;
  loadState: () => SessionSave;
  replaceSession: (checkpoint: FreshStartCheckpoint) => Promise<void>;
  saveTerminalSession: (fields: NonNullable<TerminalSessionBackup>) => Promise<void>;
  clearSessionPreservingHistory: () => void;
  checkpoint: FreshStartCheckpoint;
  onCommitted: () => void;
}): Promise<void> {
  const {
    epoch,
    getCurrentEpoch,
    loadState,
    replaceSession,
    saveTerminalSession,
    clearSessionPreservingHistory,
    checkpoint,
    onCommitted,
  } = args;

  // Cancel / epoch bump before the write lands: keep the finished freeze.
  if (epoch !== getCurrentEpoch()) return;

  // Prefer durable cache over sessionSaveRef — finishResolvedSessionDisplay
  // nulls the ref while loadState() still holds the terminal envelope.
  const prior = loadState();
  const terminalBackup: TerminalSessionBackup =
    prior.phase === 'terminal'
      ? {
          terminal: structuredClone(prior.terminal),
          presentation: structuredClone(prior.presentation),
        }
      : null;

  await replaceSession(checkpoint);

  // Write landed: from here, failure disposition is full attempt teardown so we
  // never leave a live cradle under a finished freeze / abandon-peer-only path.
  onCommitted();

  // Cancel raced the write: restore the finished freeze rather than leaving
  // preferences-only IndexedDB under a still-visible results UI.
  if (epoch !== getCurrentEpoch()) {
    if (terminalBackup) {
      await saveTerminalSession(terminalBackup);
    } else {
      clearSessionPreservingHistory();
    }
    return;
  }
}
/** Clear waiting / abandon / clean-shutdown timers and related UI flags. */
export function clearLiveSessionTimerState(setters: {
  clearTimeouts: () => void;
  clearWaitingRefs: () => void;
  setAbandonEnabled: (value: boolean) => void;
  setCleanShutdownGraceActive: (value: boolean) => void;
}): void {
  setters.clearTimeouts();
  setters.clearWaitingRefs();
  setters.setAbandonEnabled(false);
  setters.setCleanShutdownGraceActive(false);
}
