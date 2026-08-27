import type { ChannelStatus, GameConnectionState, WasmNotification } from '../../types/ChiaGaming';
import type { ComposeDraftValue } from '@games/host';
import type { ComposeDraftState } from './composeDraft';
import type { GameSliceAction } from './gameSlice';
import type {
  BetweenHandModeModel,
  GameTerminalModel,
  HandProposal,
  LocalActionKind,
  ProposalGroupDisposition,
  ProposalGroupModel,
  QueuedNotificationModel,
  RegisteredGameType,
  SessionModel,
} from './types';
import type { NonTerminalGameStatusPayload } from './presentation';
import type { RestoreStatus } from '../../hooks/SessionController';
import type { Program } from 'clvm-lib';

export type OutcomeWin = 'win' | 'lose' | 'tie';

export interface SessionMachineCoordination {
  firstGameAccepted: boolean;
  sameTermsRequested: boolean;
  expectingCounterProposal: boolean;
  lastOutcomeWin?: OutcomeWin;
  nextNotificationId: bigint;
  rejectionTimerGeneration: number;
  channelEnrichmentGeneration: number;
  gameEnrichmentGeneration: Record<string, number>;
  hostOnChain: boolean;
}

export interface SessionMachineState {
  model: SessionModel;
  coordination: SessionMachineCoordination;
}

export type LocalGameCommand =
  | { type: 'make-move'; readable: Program | null }
  | { type: 'accept-settlement' }
  | { type: 'cheat'; moverShare: bigint };

export interface LocalGameActionRequest {
  gameType: RegisteredGameType;
  id: string;
  state: unknown;
  command: LocalGameCommand;
}

export type SessionControllerCommand =
  | 'accept-proposal'
  | 'cancel-proposal'
  | 'propose-game'
  | 'clean-shutdown'
  | 'go-on-chain';

export type ProposalCommandContext =
  | 'accept-review'
  | 'choose-same-terms'
  | 'reject-current-proposal'
  | 'reject-review';

export type SessionMachineEffect =
  | { type: 'controller-accept-proposal'; id: string; context?: ProposalCommandContext }
  | { type: 'controller-cancel-proposal'; id: string; context?: ProposalCommandContext }
  | { type: 'controller-propose-game'; handProposal: HandProposal }
  | { type: 'controller-clean-shutdown' }
  | { type: 'controller-go-on-chain' }
  | { type: 'controller-set-last-outcome'; outcomeWin: OutcomeWin }
  | { type: 'timer-schedule'; key: 'rejection-fallback'; generation: number; delayMs: number }
  | { type: 'timer-cancel'; key: 'rejection-fallback' }
  | { type: 'persist-session' }
  | {
      type: 'request-coin-enrichment';
      target: 'channel' | 'game' | 'settlement';
      id: string;
      generation: number;
      coin: unknown;
      channelState?: ChannelStatus;
    }
  | { type: 'clear-derived-game-presentation' };

export type SessionMachineEvent =
  | { type: 'game'; action: GameSliceAction }
  | { type: 'channel-status'; status: SessionModel['channel']['status'] }
  | { type: 'channel-coin-enriched'; state: ChannelStatus; coinHex: string }
  | { type: 'connection'; connection: GameConnectionState }
  | {
      type: 'host-projection';
      restore: {
        restoring: boolean;
        status: RestoreStatus;
        error: string | null;
        hubReconciled: boolean;
      };
      wasmNotificationHistory: string[];
      diagnosticLog: string[];
      lastOutcomeWin: 'win' | 'lose' | 'tie' | undefined;
    }
  | { type: 'clean-shutdown-started'; started: boolean }
  | { type: 'dismissed-channel-status'; status: ChannelStatus | null }
  | { type: 'push-channel-notification'; notification: QueuedNotificationModel }
  | { type: 'push-game-notification'; notification: QueuedNotificationModel }
  | { type: 'remove-game-notifications'; kind: QueuedNotificationModel['kind'] }
  | { type: 'dismiss-channel-notification' }
  | { type: 'dismiss-channel' }
  | { type: 'dismiss-game-notification' }
  | { type: 'set-between-hand-mode'; mode: BetweenHandModeModel }
  | { type: 'upsert-proposal-group'; group: ProposalGroupModel }
  | {
      type: 'set-proposal-disposition';
      primaryId: string;
      disposition: ProposalGroupDisposition;
    }
  | { type: 'set-rejected-terms'; handProposal: HandProposal | null }
  | { type: 'set-last-terms'; handProposal: HandProposal }
  | { type: 'set-pending-retry-terms'; handProposal: HandProposal | null }
  | { type: 'set-new-hand-requested'; requested: boolean }
  | { type: 'set-compose-draft'; compose: ComposeDraftState }
  | { type: 'select-compose-game'; gameType: RegisteredGameType }
  | { type: 'set-compose-timeout'; timeout: bigint }
  | { type: 'update-selected-compose-draft'; draft: Partial<ComposeDraftValue> }
  | { type: 'set-compose-proposal-sent'; sent: boolean }
  | { type: 'clear-proposals'; ids?: readonly string[] }
  | { type: 'set-same-terms-requested'; requested: boolean }
  | { type: 'set-expecting-counter-proposal'; expecting: boolean }
  | { type: 'set-first-game-accepted'; accepted: boolean }
  | { type: 'set-last-outcome'; outcomeWin: OutcomeWin }
  | {
      type: 'notification-accepted-group';
      id: string;
      amount: string;
      iStarted: boolean;
      isMyTurn: boolean;
    }
  | {
      type: 'notification-game-status';
      id: string;
      payload: NonTerminalGameStatusPayload;
      channelState: ChannelStatus;
      readable: Uint8Array | null;
      moverShare: string | null;
      iStarted: boolean;
    }
  | { type: 'notification-game-terminal'; id: string; terminal: GameTerminalModel }
  | {
      type: 'notification-move-rejected';
      id: string;
      tag: string;
      message: string;
    }
  | {
      type: 'notification-insufficient-balance';
      id: string;
      notification: QueuedNotificationModel;
    }
  | { type: 'notification-abandoned' }
  | {
      type: 'feature-state';
      gameType: RegisteredGameType;
      id: string;
      state: unknown;
    }
  | {
      type: 'local-game-action-staged';
      gameType: RegisteredGameType;
      id: string;
      action: LocalActionKind;
      state: unknown;
    }
  | {
      type: 'local-game-action-applied';
      gameType: RegisteredGameType;
      id: string;
      action: LocalActionKind;
      state: unknown;
    }
  | { type: 'local-action-applied'; id: string; action: LocalActionKind }
  | { type: 'discard-pending-candidate'; id: string; action?: LocalActionKind }
  | { type: 'request-accept-proposal'; id: string }
  | { type: 'request-cancel-proposal'; id: string }
  | { type: 'request-propose-game'; handProposal: HandProposal }
  | { type: 'proposal-sent'; ids: string[]; handProposal: HandProposal }
  | {
      type: 'proposal-command-succeeded';
      command: 'accept-proposal' | 'cancel-proposal';
      id: string;
      context?: ProposalCommandContext;
    }
  | { type: 'clean-shutdown-command-succeeded' }
  | { type: 'controller-command-failed'; command: SessionControllerCommand; message: string }
  | { type: 'choose-same-terms' }
  | { type: 'reject-current-proposal' }
  | { type: 'open-compose' }
  | { type: 'submit-compose'; handProposal: HandProposal }
  | { type: 'accept-review' }
  | { type: 'reject-review' }
  | { type: 'start-clean-shutdown' }
  | { type: 'go-on-chain' }
  | { type: 'go-on-chain-result'; started: boolean }
  | { type: 'rejection-fallback-fired'; generation: number }
  | { type: 'wasm-notification'; notification: WasmNotification; iStarted: boolean }
  | {
      type: 'enqueue-error';
      kind: 'infra-error' | 'action-failed' | 'durability-error';
      message: string;
    }
  | {
      type: 'coin-enrichment-completed';
      target: 'channel' | 'game' | 'settlement';
      id: string;
      generation: number;
      coinHex: string | null;
      channelState?: ChannelStatus;
    };

export interface SessionMachineTransition {
  state: SessionMachineState;
  effects: SessionMachineEffect[];
}
