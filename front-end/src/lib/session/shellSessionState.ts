import type { GameSessionParams, PeerConnectionResult, SessionPhase } from '../../types/ChiaGaming';
import type { AdvisoryStartParams } from '../../services/HubConnection';
import type { RestoreStatus } from '../../hooks/SessionController';
import type { AcceptReason } from './acceptLifecycle';
import type { SessionModel } from './model';

export type PendingSessionProposal = {
  from_id: string;
  from_alias: string;
  proposer_amount: string;
  responder_amount: string;
  channel_timeout?: string;
  unroll_timeout?: string;
  game_session_id?: string;
};

/** Accept is the only remaining session-pane transition reason. */
export type ShellSessionTransitionReason = AcceptReason;

/** Session-pane only — unused shell-scope overlays were deleted. */
export type ShellSessionTransitionScope = 'session-pane';

export type ShellSessionTransition =
  | { kind: 'idle' }
  | {
      kind: 'pending';
      reason: ShellSessionTransitionReason;
      scope: ShellSessionTransitionScope;
      readyKey: string | null;
    };

/** True while Accept (advisory/proposal) transition work is in flight. */
export function isAcceptSessionTransition(transition: ShellSessionTransition): boolean {
  return (
    transition.kind === 'pending' &&
    (transition.reason === 'accept-advisory' || transition.reason === 'accept-proposal')
  );
}

export interface ShellSessionState {
  sessionConfig: GameSessionParams | null;
  peerConn: PeerConnectionResult | null;
  dashboardSessionModel: SessionModel | null;
  sessionPhase: SessionPhase;
  pendingAdvisory: AdvisoryStartParams | null;
  pendingProposal: PendingSessionProposal | null;
  sessionError: boolean;
  restoreStatus: RestoreStatus;
  restoreError: string | null;
  restoreHubReconciled: boolean;
  transition: ShellSessionTransition;
}

export type ShellSessionAction =
  | { type: 'setSessionConfig'; value: GameSessionParams | null }
  | { type: 'setPeerConn'; value: PeerConnectionResult | null }
  | { type: 'setDashboardSessionModel'; value: SessionModel | null }
  | { type: 'setSessionPhase'; value: SessionPhase }
  | { type: 'setPendingAdvisory'; value: AdvisoryStartParams | null }
  | { type: 'setPendingProposal'; value: PendingSessionProposal | null }
  | { type: 'setSessionError'; value: boolean }
  | { type: 'setRestoreStatus'; value: RestoreStatus }
  | { type: 'setRestoreError'; value: string | null }
  | { type: 'setRestoreHubReconciled'; value: boolean }
  | {
      type: 'beginAccept';
      reason: ShellSessionTransitionReason;
      readyKey: string;
    }
  | {
      type: 'startTransition';
      reason: ShellSessionTransitionReason;
      scope: ShellSessionTransitionScope;
      readyKey: string | null;
    }
  | { type: 'liveMounted'; sessionConfig: GameSessionParams; peerConn: PeerConnectionResult }
  | { type: 'acceptAborted'; error?: boolean }
  | { type: 'completeTransition'; readyKey: string }
  | { type: 'endTransition' };

export const initialShellSessionState: ShellSessionState = {
  sessionConfig: null,
  peerConn: null,
  dashboardSessionModel: null,
  sessionPhase: 'none',
  pendingAdvisory: null,
  pendingProposal: null,
  sessionError: false,
  restoreStatus: 'idle',
  restoreError: null,
  restoreHubReconciled: false,
  transition: { kind: 'idle' },
};

export function shellSessionReducer(
  state: ShellSessionState,
  action: ShellSessionAction,
): ShellSessionState {
  switch (action.type) {
    case 'setSessionConfig':
      return { ...state, sessionConfig: action.value };
    case 'setPeerConn':
      return { ...state, peerConn: action.value };
    case 'setDashboardSessionModel':
      return { ...state, dashboardSessionModel: action.value };
    case 'setSessionPhase':
      return { ...state, sessionPhase: action.value };
    case 'setPendingAdvisory':
      return { ...state, pendingAdvisory: action.value };
    case 'setPendingProposal':
      return { ...state, pendingProposal: action.value };
    case 'setSessionError':
      return { ...state, sessionError: action.value };
    case 'setRestoreStatus':
      return { ...state, restoreStatus: action.value };
    case 'setRestoreError':
      return { ...state, restoreError: action.value };
    case 'setRestoreHubReconciled':
      return { ...state, restoreHubReconciled: action.value };
    case 'beginAccept':
      // Clears consent prompts atomically with entering the Accept transition.
      return {
        ...state,
        pendingAdvisory: null,
        pendingProposal: null,
        transition: {
          kind: 'pending',
          reason: action.reason,
          scope: 'session-pane',
          readyKey: action.readyKey,
        },
      };
    case 'startTransition':
      return {
        ...state,
        transition: {
          kind: 'pending',
          reason: action.reason,
          scope: action.scope,
          readyKey: action.readyKey,
        },
      };
    case 'liveMounted':
      return {
        ...state,
        sessionConfig: action.sessionConfig,
        peerConn: action.peerConn,
      };
    case 'acceptAborted':
      return {
        ...state,
        pendingAdvisory: null,
        pendingProposal: null,
        sessionError: !!action.error,
        transition: { kind: 'idle' },
      };
    case 'completeTransition':
      return state.transition.kind === 'pending' && state.transition.readyKey === action.readyKey
        ? { ...state, transition: { kind: 'idle' } }
        : state;
    case 'endTransition':
      return { ...state, transition: { kind: 'idle' } };
    default:
      return state;
  }
}
