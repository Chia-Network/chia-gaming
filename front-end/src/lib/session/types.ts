import type {
  ChannelStatus,
  ChannelStatusPayload,
  GameConnectionState,
  PeerLiveness,
  SessionDisposition,
  SessionPhase,
} from '../../types/ChiaGaming';
import type { RestoreStatus } from '../../hooks/SessionController';
import type { SettlementOutcome } from '../settlement';
import type { PersistedGameState } from './gameStateCodec';

export type GameTurnState =
  | 'my-turn'
  | 'their-turn'
  | 'playing-on-chain'
  | 'replaying'
  | 'opponent-illegal-move'
  | 'submitting-timeout'
  | 'finishing'
  | 'ended';

export type HandStatus =
  | 'none'
  | 'active'
  | 'their-turn'
  | 'our-turn'
  | 'playing-move'
  | 'replaying-move'
  | 'slashing'
  | 'submitting-timeout'
  | 'finishing'
  | 'ended';

export type GameProtocolPresentation =
  | 'off-chain-my-turn'
  | 'off-chain-their-turn'
  | 'on-chain-my-turn'
  | 'on-chain-their-turn'
  | 'playing-move'
  | 'replaying-move'
  | 'illegal-move'
  | 'submitting-timeout'
  | 'finishing'
  | 'ended';

export type GameTerminalType =
  | 'none'
  | 'settled'
  | 'insufficient-balance'
  | 'ended-cancelled'
  | 'game-error';

export interface GameTerminalModel {
  type: GameTerminalType;
  outcome: SettlementOutcome | null;
  label: string | null;
  myReward: string | null;
  rewardCoinHex: string | null;
}

/** Canonical mutable/persisted game instance. */
export interface GameInstanceModel {
  id: string;
  amount: string;
  coinHex: string | null;
  presentation: GameProtocolPresentation;
  terminal: GameTerminalModel;
}

/** Derived compatibility view; never stored in SessionModel or SessionSave. */
export interface GameInstanceViewModel {
  id: string;
  amount: string;
  coin: GameCoinModel;
  handStatus: HandStatus;
  terminal: GameTerminalModel;
}

export interface GameCoinModel {
  coinHex: string | null;
  turnState: GameTurnState;
  onChain?: boolean;
}

export type NotificationKind =
  | 'channel-state'
  | 'action-failed'
  | 'infra-error'
  | 'durability-error'
  | 'game-terminal'
  | 'proposal-rejected'
  | 'insufficient-bal';

export interface ChannelStatusModel {
  state: ChannelStatus;
  sessionDisposition: SessionDisposition | null;
  advisory: string | null;
  coin: Uint8Array | null;
  coinHex: string | null;
  coinAmount: string | null;
  ourBalance: string | null;
  theirBalance: string | null;
  gameAllocated: string | null;
  havePotato: boolean | null;
  zeroPayout: boolean | null;
  unrollInitiator: 'us' | 'opponent' | null;
  semanticPhase: ChannelStatusPayload['semantic_phase'] | null;
}

export interface QueuedNotificationModel {
  id: bigint;
  kind: NotificationKind;
  title: string;
  message: string;
  payload?:
    | ChannelStatusModel
    | { label: string; myReward: string | null; rewardCoinHex: string | null };
}

export interface HandTermsBaseModel {
  myContribution: bigint;
  theirContribution: bigint;
  gameTimeout: bigint;
}

export type RegisteredGameType = 'calpoker' | 'spacepoker' | 'krunk';

export type HandTermsModel =
  | (HandTermsBaseModel & { gameType: 'calpoker' })
  | (HandTermsBaseModel & { gameType: 'spacepoker'; unitSizeMojos: bigint })
  | (HandTermsBaseModel & { gameType: 'krunk' });

export interface BetweenHandProposalModel {
  id: string;
  groupIds: string[];
  terms: HandTermsModel;
}

export type BetweenHandModeModel = 'decision' | 'compose-proposal' | 'review-incoming-proposal';

export interface RestoreModel {
  restoring: boolean;
  status: RestoreStatus;
  error: string | null;
  hubReconciled: boolean;
}

export interface PeerModel {
  connected: boolean | null;
}

export interface ChannelModel {
  status: ChannelStatusModel;
  connection: GameConnectionState;
  cleanShutdownStarted: boolean;
  dismissedChannelStatus: ChannelStatus | null;
  queue: QueuedNotificationModel[];
}

export interface GameModel {
  handKey: number;
  activeIds: string[];
  currentHandIds: string[];
  instances: Record<string, GameInstanceModel>;
  lastDisplayedId: string | null;
  activeGameType: RegisteredGameType;
  handState: PersistedGameState | null;
  queue: QueuedNotificationModel[];
}

export interface BetweenHandModel {
  mode: BetweenHandModeModel;
  cachedPeerProposal: BetweenHandProposalModel | null;
  reviewPeerProposal: BetweenHandProposalModel | null;
  rejectedOnceTerms: HandTermsModel | null;
  lastTerms: HandTermsModel;
  composePerHandAmount: bigint;
  composeGameTimeout: bigint;
  composeGameType: RegisteredGameType;
  composeProposalSent: boolean;
  newHandRequested: boolean;
  outgoingProposalIds: string[];
  outgoingProposalGroupIds: string[][];
  acceptedProposalGroupIds: string[][];
  outgoingProposalTerms: Record<string, HandTermsModel>;
  pendingRetryTerms: HandTermsModel | null;
}

export interface SessionHistoryModel {
  humanHistory: string[];
  wasmNotificationHistory: string[];
  diagnosticLog: string[];
}

export interface SessionModel {
  restore: RestoreModel;
  peer: PeerModel;
  channel: ChannelModel;
  game: GameModel;
  betweenHand: BetweenHandModel;
  history: SessionHistoryModel;
  myRunningBalance: bigint;
  lastOutcomeWin?: 'win' | 'lose' | 'tie';
}

type LegacyGameInput = Omit<Partial<GameModel>, 'instances'> & {
  instances?: Record<string, GameInstanceModel | GameInstanceViewModel>;
};

export interface SessionModelInput {
  restore?: Partial<RestoreModel>;
  peer?: Partial<PeerModel>;
  channel?: Partial<ChannelModel>;
  game?: LegacyGameInput;
  betweenHand?: Partial<BetweenHandModel>;
  history?: Partial<SessionHistoryModel>;
  myRunningBalance?: bigint;
  lastOutcomeWin?: 'win' | 'lose' | 'tie';
}

export type GameDashboardActionKind =
  | 'none'
  | 'cancel'
  | 'clean-shutdown'
  | 'go-on-chain'
  | 'abandon';
export type GameDashboardActionLabel =
  | 'No Session'
  | 'Cancel'
  | 'Waiting'
  | 'Clean Shutdown'
  | 'Go On-Chain'
  | 'Abandon'
  | 'Done';

export interface GameDashboardViewModel {
  channelStatusLabel: string;
  channelDetail: string | null;
  havePotato: boolean;
  handStatusLabel: string;
  handDetail: string | null;
  lifecycleRows: Array<{ id: string; label: string; statusLabel: string; detail: string | null }>;
  actionLabel: GameDashboardActionLabel;
  actionEnabled: boolean;
  actionKind: GameDashboardActionKind;
}

export interface StatusBarBalanceSegment {
  label: string;
  value: string;
  value2?: string;
}

export type { PeerLiveness, SessionPhase };
export type { GameStateCodec, PersistedGameState } from './gameStateCodec';
