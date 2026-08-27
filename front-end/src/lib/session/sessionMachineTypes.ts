import type { ChannelStatus, GameConnectionState, WasmNotification } from '../../types/ChiaGaming';
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
import type { PersistedGameState } from '@games/host';

export interface SessionMachineCoordination {
  firstGameAccepted: boolean;
  sameTermsRequested: boolean;
  nextNotificationId: bigint;
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
  | { type: 'select-compose-game'; gameType: RegisteredGameType }
  | { type: 'set-compose-timeout'; timeout: bigint }
  | { type: 'set-compose-proposal-sent'; sent: boolean }
  | { type: 'clear-proposals'; ids?: readonly string[] }
  | { type: 'set-same-terms-requested'; requested: boolean }
  | { type: 'set-first-game-accepted'; accepted: boolean }
  | {
      type: 'notification-accepted-group';
      members: readonly {
        id: string;
        playerAContribution: bigint;
        playerBContribution: bigint;
        ourTurn: boolean;
      }[];
      handState?: PersistedGameState;
    }
  | {
      type: 'notification-game-status';
      id: string;
      payload: NonTerminalGameStatusPayload;
      channelState: ChannelStatus;
      readable: Uint8Array | null;
      moverShare: bigint | null;
      iStarted: boolean;
      handState?: PersistedGameState;
    }
  | {
      type: 'notification-game-terminal';
      id: string;
      terminal: GameTerminalModel;
      handState?: PersistedGameState;
    }
  | {
      type: 'notification-insufficient-balance';
      id: string;
      notification: QueuedNotificationModel;
    }
  | { type: 'notification-abandoned' }
  | {
      type: 'hand-state-changed';
      gameType: RegisteredGameType;
      state: unknown;
      handState?: PersistedGameState;
    }
  | {
      type: 'local-game-action-committed';
      gameType: RegisteredGameType;
      id: string;
      state: unknown;
      handState?: PersistedGameState;
    }
  | { type: 'local-action-applied'; id: string; action: LocalActionKind }
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
