import type { ChannelStatusPayload } from '../../types/ChiaGaming';
import type { PersistedGameState } from './gameStateCodec';
import type { GameProtocolPresentation } from './gameSlice';
import type {
  BetweenHandModeModel,
  NotificationKind,
  ProposalGroupDisposition,
  ProposalGroupOrigin,
  RegisteredGameType,
} from './types';

export const SESSION_SAVE_SCHEMA = 'chia-gaming-session' as const;
export const SESSION_SAVE_VERSION = 14n;

export type BlockchainType = 'simulator' | 'walletconnect';

export type ChiaNetwork = 'mainnet' | 'testnet';

export interface SessionIdentitySave {
  playerId: string;
  sessionId?: string;
  myHubPlayerId?: string;
}

export interface SessionPreferencesSave {
  alias?: string;
  theme?: 'dark' | 'light';
  defaultFee?: bigint;
  feeUnit?: 'mojo' | 'xch';
  hubUrl?: string;
  activeTab?: string;
  unreadGame?: boolean;
  walletAlert?: boolean;
  hubAlert?: boolean;
  blockchainType?: BlockchainType;
  network?: ChiaNetwork;
}

export interface SessionHistorySave {
  humanHistory?: string[];
  wasmNotificationHistory?: string[];
  diagnosticLog?: string[];
}

export interface SessionPairingSave {
  token: string;
  peerId?: string;
  gameSessionId?: string;
  iStarted: boolean;
  myContribution: string;
  theirContribution: string;
  perGameAmount: string;
  channelTimeout?: string;
  unrollTimeout?: string;
  myAlias?: string;
  opponentAlias?: string;
}

export interface SessionLiveSave {
  serializedGameSession: Uint8Array;
  gameSessionSchemaVersion: bigint;
  rewardPuzzleHash: string;
  messageNumber: bigint;
  remoteNumber: bigint;
  unackedMessages: Array<{ msgno: bigint; msg: Uint8Array }>;
  durabilityWarning?: string;
}

export interface SavedGameInstance {
  id: string;
  amount: string;
  coinHex: string | null;
  presentation: GameProtocolPresentation;
  terminal: {
    type: string;
    outcome: string | null;
    label: string | null;
    myReward: string | null;
    rewardCoinHex: string | null;
  };
}

interface SavedHandTermsBase {
  my_contribution: string;
  their_contribution: string;
  game_timeout: string;
}

export type SavedHandTerms = SavedHandTermsBase & {
  game_type: RegisteredGameType;
} & Record<string, string | undefined>;

export interface SavedQueuedNotification {
  id: bigint;
  kind: NotificationKind;
  title: string;
  message: string;
}

export interface SessionPresentationSave {
  activeGameIds: string[];
  currentHandGameIds: string[];
  currentHandOrigin: ProposalGroupOrigin | null;
  lastDisplayedGameId: string | null;
  gameInstances: Record<string, SavedGameInstance>;
  activeGameType: RegisteredGameType;
  handState: PersistedGameState | null;
  channelStatus: ChannelStatusPayload | null;
  lastOutcomeWin: 'win' | 'lose' | 'tie' | null;
  myRunningBalance: string;
  channelNotifQueue: SavedQueuedNotification[];
  gameNotifQueue: SavedQueuedNotification[];
  dismissedChannelStatus: ChannelStatusPayload['state'] | null;
  cleanShutdownStarted: boolean;
  betweenHandMode: BetweenHandModeModel;
  betweenHandCompose: {
    selected_game: RegisteredGameType;
    game_timeout: string;
    proposal_sent: boolean;
    drafts: Record<string, Record<string, string>>;
  };
  betweenHandLastTerms: SavedHandTerms | null;
  betweenHandRejectedOnceTerms: SavedHandTerms | null;
  betweenHandPendingRetryTerms: SavedHandTerms | null;
  proposalGroups: Array<{
    primary_id: string;
    member_ids: string[];
    origin: ProposalGroupOrigin;
    disposition: ProposalGroupDisposition;
    terms: SavedHandTerms;
  }>;
  waitingStateEnteredAt: bigint | null;
  cleanShutdownGraceStartedAt: bigint | null;
}

interface SessionSaveBase {
  schema: typeof SESSION_SAVE_SCHEMA;
  version: typeof SESSION_SAVE_VERSION;
  identity: SessionIdentitySave;
  preferences: SessionPreferencesSave;
  history: SessionHistorySave;
}

export interface PreferencesSessionSave extends SessionSaveBase {
  phase: 'preferences';
}

export interface PreHandshakeSessionSave extends SessionSaveBase {
  phase: 'pre-handshake';
  pairing: SessionPairingSave;
}

export interface LiveSessionSave extends SessionSaveBase {
  phase: 'live';
  pairing: SessionPairingSave;
  live: SessionLiveSave;
  presentation: SessionPresentationSave;
}

export interface TerminalSessionSave extends SessionSaveBase {
  phase: 'terminal';
  terminal: {
    iStarted: boolean;
    coinsOfInterest: Array<{ label: string; id: string }>;
    myAlias: string | null;
    opponentAlias: string | null;
  };
  presentation: SessionPresentationSave;
}

export type SessionSave =
  | PreferencesSessionSave
  | PreHandshakeSessionSave
  | LiveSessionSave
  | TerminalSessionSave;

export function assertNever(value: never): never {
  throw new Error(`Unexpected session phase: ${String(value)}`);
}
