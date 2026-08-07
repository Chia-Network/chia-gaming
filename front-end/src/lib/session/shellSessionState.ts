import type { GameSessionParams, PeerConnectionResult, SessionPhase } from '../../types/ChiaGaming';
import type { AdvisoryStartParams } from '../../services/HubConnection';
import type { RestoreStatus } from '../../hooks/SessionController';
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

export type ShellSessionTransitionReason =
  | 'accept-advisory'
  | 'accept-proposal'
  | 'resume'
  | 'start-over'
  | 'disconnect'
  | 'finish';

export type ShellSessionTransitionScope = 'shell' | 'session-pane';

export type ShellSessionTransition =
  | { kind: 'idle' }
  | {
      kind: 'pending';
      reason: ShellSessionTransitionReason;
      scope: ShellSessionTransitionScope;
      readyKey: string | null;
    };

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
      type: 'startTransition';
      reason: ShellSessionTransitionReason;
      scope: ShellSessionTransitionScope;
      readyKey: string | null;
    }
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
