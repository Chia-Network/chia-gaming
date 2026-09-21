/**
 * Accept lifecycle: peer consent → live checkpoint → GameSession mount.
 *
 * Owns freeze-safe disposition for Cancel / peer reject / delivery failure /
 * remap during Accept. Failures before replaceSession lands abandon the peer
 * attempt only; after the write, full attempt teardown is required.
 */

import type {
  DurableApplicationState,
  DurableSessionPhase,
  SessionHistorySave,
  SessionIdentitySave,
  SessionPairingSave,
  SessionTransportSave,
} from './saveEnvelope';
import type { ChannelStatus, WalletProviderScope } from '../../types/ChiaGaming';
import type { SessionModel } from './types';
import { PRE_ACTIVE_CHANNEL_STATES } from './selectors';
import { captureDurableApplicationState } from './sessionMachinePersist';

export type AcceptPhase = 'idle' | 'accepting' | 'persistDraining' | 'liveMounting' | 'active';

export type AcceptReason = 'accept-advisory' | 'accept-proposal';

export type StartFailureDisposition = 'abandon-peer-only' | 'cancel-attempt';

/** Single setup copy for Accept session-pane covers. */
export const ACCEPT_SETTING_UP_COPY = 'Setting up channel…';

export function channelSetupCoverCopy(
  handEverStarted: boolean,
  status: Pick<SessionModel['channel']['status'], 'state' | 'advisory'>,
): string | null {
  if (status.state === 'Failed') {
    return status.advisory?.trim() || 'Channel setup failed.';
  }
  return !handEverStarted || PRE_ACTIVE_CHANNEL_STATES.has(status.state)
    ? ACCEPT_SETTING_UP_COPY
    : null;
}

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

export type FreshStartCheckpoint = {
  walletProviderScope: WalletProviderScope;
  pairing: SessionPairingSave;
  transport: SessionTransportSave;
  identity?: Partial<SessionIdentitySave>;
  history?: Partial<SessionHistorySave>;
};

export function applyFreshStartCheckpoint(
  state: DurableApplicationState,
  checkpoint: FreshStartCheckpoint,
): DurableApplicationState {
  return {
    ...state,
    identity: { ...state.identity, ...checkpoint.identity },
    history: { ...state.history, ...checkpoint.history },
    walletContext: structuredClone(checkpoint.walletProviderScope),
    session: {
      phase: 'pre-handshake',
      pairing: structuredClone(checkpoint.pairing),
      transport: structuredClone(checkpoint.transport),
    },
  };
}

/**
 * Capture the pre-cradle phase through the aggregate boundary. If cancellation
 * races the write, restore the prior terminal phase (or no phase) through that
 * same boundary.
 */
export async function captureFreshStart(args: {
  epoch: number;
  getCurrentEpoch: () => number;
  checkpoint: FreshStartCheckpoint;
  onCommitted: () => void;
}): Promise<void> {
  const { epoch, getCurrentEpoch, checkpoint, onCommitted } = args;

  if (epoch !== getCurrentEpoch()) return;

  let priorSession: DurableSessionPhase | null = null;
  let priorWalletContext: DurableApplicationState['walletContext'] = null;
  const prepared = captureDurableApplicationState({
    kind: 'transform',
    transform: (state: DurableApplicationState) => {
      priorSession = state.session?.phase === 'terminal' ? structuredClone(state.session) : null;
      priorWalletContext = structuredClone(state.walletContext);
      return applyFreshStartCheckpoint(state, checkpoint);
    },
  });
  if (!prepared) throw new Error('Fresh-start capture unexpectedly produced no aggregate');
  await prepared.write();
  onCommitted();

  if (epoch !== getCurrentEpoch()) {
    await captureDurableApplicationState({
      kind: 'transform',
      transform: (state) => ({
        ...state,
        session: structuredClone(priorSession),
        walletContext: structuredClone(priorWalletContext),
      }),
    })?.write();
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
