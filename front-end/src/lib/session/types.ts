import type {
  ChannelStatus,
  ChannelStatusPayload,
  GameConnectionState,
  PeerLiveness,
  SessionDisposition,
  SessionPhase,
} from '../../types/ChiaGaming';
import type { RestoreStatus } from '../../hooks/SessionController';
import type { ComposeDraftState } from './composeDraft';
import type { PersistedGameState, SettlementOutcome } from '@games/host';

export type { HandProposalBase, ProposalGroupOrigin } from '@games/host';
import type { HandProposal as HostHandProposal, ProposalGroupOrigin } from '@games/host';
import type { CatalogGameType } from '../../generated/gamePresets';

export type RegisteredGameType = CatalogGameType;
export type { CatalogGameType };

export type LocalActionKind = 'make_move' | 'accept_settlement' | 'cheat';

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

export const EMPTY_GAME_TERMINAL_MODEL: GameTerminalModel = {
  type: 'none',
  outcome: null,
  label: null,
  myReward: null,
  rewardCoinHex: null,
};

export type GameTurnState =
  | 'my-turn'
  | 'their-turn'
  | 'playing-on-chain'
  | 'replaying'
  | 'opponent-illegal-move'
  | 'submitting-timeout'
  | 'finishing'
  | 'finishing-waiting-timeout'
  | 'finishing-spending'
  | 'ended';

export interface PendingGameCandidate {
  gameType: RegisteredGameType;
  id: string;
  action: LocalActionKind;
  state: unknown;
}

export type HandProposal = Omit<HostHandProposal, 'gameType'> & {
  gameType: CatalogGameType;
};

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
  | 'finishing-waiting-timeout'
  | 'finishing-spending'
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
  | 'finishing-waiting-timeout'
  | 'finishing-spending'
  | 'ended';

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
  stateNumber: bigint | null;
  unrollingStateNumber: bigint | null;
  preemptingStateNumber: bigint | null;
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

export type ProposalGroupDisposition =
  | 'outgoing'
  | 'incoming-cached'
  | 'incoming-review'
  | 'accepted';

export interface ProposalGroupModel {
  primaryId: string;
  memberIds: string[];
  handProposal: HandProposal;
  origin: ProposalGroupOrigin;
  disposition: ProposalGroupDisposition;
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
  currentHandOrigin: ProposalGroupOrigin | null;
  instances: Record<string, GameInstanceModel>;
  lastDisplayedId: string | null;
  activeGameType: RegisteredGameType;
  handState: PersistedGameState | null;
  pendingCandidates: Record<string, PendingGameCandidate>;
  queue: QueuedNotificationModel[];
}

export interface BetweenHandModel {
  mode: BetweenHandModeModel;
  proposalGroups: ProposalGroupModel[];
  rejectedOnceHandProposal: HandProposal | null;
  lastHandProposal: HandProposal | null;
  compose: ComposeDraftState;
  newHandRequested: boolean;
  pendingRetryHandProposal: HandProposal | null;
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

export type BannerTone = 'idle' | 'playing' | 'pings-bad' | 'on-chain' | 'ended';

export interface GameDashboardViewModel {
  bannerTone: BannerTone;
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
export type { PersistedGameState } from '@games/host';
