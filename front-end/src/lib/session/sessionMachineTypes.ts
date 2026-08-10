import type { ChannelStatus, GameConnectionState, WasmNotification } from '../../types/ChiaGaming';
import type { PersistedGameState } from './gameStateCodec';
import type { ComposeDraftState } from './composeDraft';
import type { GameSliceAction } from './gameSlice';
import type { GameplayEvent } from './gameSessionEvents';
import type {
  BetweenHandModeModel,
  BetweenHandProposalModel,
  GameTerminalModel,
  HandTermsModel,
  QueuedNotificationModel,
  RegisteredGameType,
  SessionModel,
} from './types';
import type { NonTerminalGameStatusPayload } from './presentation';
import type { RestoreStatus } from '../../hooks/SessionController';

export type OutcomeWin = 'win' | 'lose' | 'tie';

export interface SessionMachineCoordination {
  firstGameAccepted: boolean;
  sameTermsRequested: boolean;
  expectingCounterProposal: boolean;
  iProposedHand: boolean;
  lastOutcomeWin?: OutcomeWin;
  proposalTermsById: Record<string, HandTermsModel>;
  proposalGroupIdsById: Record<string, string[]>;
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
  | { type: 'controller-propose-game'; terms: HandTermsModel }
  | { type: 'controller-clean-shutdown' }
  | { type: 'controller-go-on-chain' }
  | { type: 'controller-set-last-outcome'; outcomeWin: OutcomeWin }
  | { type: 'timer-schedule'; key: 'rejection-fallback'; generation: number; delayMs: number }
  | { type: 'timer-cancel'; key: 'rejection-fallback' }
  | { type: 'persist-session' }
  | { type: 'emit-gameplay'; event: GameplayEvent }
  | {
      type: 'request-coin-enrichment';
      target: 'channel' | 'game' | 'settlement';
      id: string;
      generation: number;
      coin: unknown;
      channelState?: ChannelStatus;
    }
  | { type: 'set-hand-state'; state: PersistedGameState | null }
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
  | { type: 'set-cached-proposal'; proposal: BetweenHandProposalModel | null }
  | { type: 'set-review-proposal'; proposal: BetweenHandProposalModel | null }
  | { type: 'set-rejected-terms'; terms: HandTermsModel | null }
  | { type: 'set-last-terms'; terms: HandTermsModel }
  | { type: 'set-pending-retry-terms'; terms: HandTermsModel | null }
  | { type: 'set-new-hand-requested'; requested: boolean }
  | { type: 'set-compose-draft'; compose: ComposeDraftState }
  | { type: 'select-compose-game'; gameType: RegisteredGameType }
  | { type: 'set-compose-timeout'; timeout: bigint }
  | { type: 'set-compose-amount'; gameType: 'calpoker' | 'krunk'; amount: bigint }
  | {
      type: 'set-spacepoker-compose';
      draft: Partial<ComposeDraftState['spacepoker']>;
    }
  | { type: 'set-compose-proposal-sent'; sent: boolean }
  | { type: 'track-proposal'; ids: string[]; terms: HandTermsModel; outgoing: boolean }
  | { type: 'clear-proposals'; ids?: readonly string[] }
  | { type: 'begin-accepted-group'; groupIds: string[] }
  | { type: 'finish-proposal-wave' }
  | { type: 'remove-accepted-group'; groupIds: readonly string[] }
  | { type: 'set-same-terms-requested'; requested: boolean }
  | { type: 'set-expecting-counter-proposal'; expecting: boolean }
  | { type: 'set-first-game-accepted'; accepted: boolean }
  | { type: 'set-i-proposed-hand'; proposed: boolean }
  | { type: 'set-last-outcome'; outcomeWin: OutcomeWin }
  | { type: 'hand-outcome'; outcomeWin: OutcomeWin }
  | {
      type: 'notification-accepted-group';
      id: string;
      groupIds: string[];
      amount: string;
      terms: HandTermsModel;
      weProposed: boolean;
      iStarted: boolean;
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
      type: 'notification-insufficient-balance';
      id: string;
      groupIds: string[];
      notification: QueuedNotificationModel;
    }
  | { type: 'notification-abandoned' }
  | {
      type: 'feature-state';
      gameType: RegisteredGameType;
      id: string;
      state: unknown;
    }
  | { type: 'durable-local-turn'; id: string; isMyTurn: boolean; channelState: ChannelStatus }
  | { type: 'request-accept-proposal'; id: string }
  | { type: 'request-cancel-proposal'; id: string }
  | { type: 'request-propose-game'; terms: HandTermsModel }
  | { type: 'proposal-sent'; ids: string[]; terms: HandTermsModel }
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
  | { type: 'submit-compose'; terms: HandTermsModel }
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
