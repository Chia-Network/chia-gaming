import type {
  ChannelStatusPayload,
  CoinOfInterestEntry,
  WalletProviderScope,
} from '../../types/ChiaGaming';
import type { PersistedGameState } from '@games/host';
import type {
  BetweenHandModeModel,
  GameInstanceModel,
  HandProposal,
  PendingProposalModel,
  ProposalOrigin,
  RegisteredGameType,
} from './types';
import type { ComposeDraftState } from './composeDraft';
import type { ChannelFundingEntry } from './channelFundingStore';
import type { FeeAttachment } from './feeAttachmentStore';

export const DURABLE_APPLICATION_STATE_SCHEMA = 'chia-gaming-application-state' as const;
export const DURABLE_APPLICATION_STATE_VERSION = 5n;
export const MAX_DURABLE_REJECTION_TRANSPORTS = 8;

export type BlockchainType = 'simulator' | 'walletconnect' | 'cloud';

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
  gameSessionId: string;
  iStarted: boolean;
  myContribution: string;
  theirContribution: string;
  perGameAmount: string;
  channelTimeout?: string;
  unrollTimeout?: string;
  myAlias?: string;
  opponentAlias?: string;
}

export interface SessionTransportSave {
  messageNumber: bigint;
  remoteNumber: bigint;
  unackedMessages: Array<{ msgno: bigint; msg: Uint8Array }>;
  disposition: 'active' | 'proposal-received' | 'outbound-reject' | 'inbound-reject';
  terminalHandoff: SessionTerminalHandoffSave | null;
}

export interface SessionTerminalHandoffSave {
  id: string;
  message: Uint8Array;
  msgno: bigint;
  sent: boolean;
  acknowledged: boolean;
}

export interface SessionLiveSave extends SessionTransportSave {
  serializedGameSession: Uint8Array;
  gameSessionSchemaVersion: bigint;
  rewardPuzzleHash: string;
}

export interface SessionPresentationSave {
  handKey: bigint;
  activeGameIds: string[];
  currentHandGameIds: string[];
  currentHandOrigin: ProposalOrigin | null;
  lastDisplayedGameId: string | null;
  gameInstances: Record<string, GameInstanceModel>;
  activeGameType: RegisteredGameType;
  handState: PersistedGameState | null;
  channelStatus: ChannelStatusPayload | null;
  cleanShutdownStarted: boolean;
  betweenHandMode: BetweenHandModeModel;
  betweenHandCompose: Pick<ComposeDraftState, 'selectedGame' | 'gameTimeout'>;
  betweenHandLastHandProposal: HandProposal | null;
  betweenHandRejectedOnceHandProposal: HandProposal | null;
  betweenHandPendingRetryHandProposal: HandProposal | null;
  newHandRequested: boolean;
  pendingProposals: PendingProposalModel[];
  waitingStateEnteredAt: bigint | null;
  cleanShutdownGraceStartedAt: bigint | null;
}

export interface PreHandshakeSessionSave {
  phase: 'pre-handshake';
  pairing: SessionPairingSave;
  transport: SessionTransportSave;
}

export interface LiveSessionSave {
  phase: 'live';
  pairing: SessionPairingSave;
  live: SessionLiveSave;
  presentation: SessionPresentationSave;
}

export interface TerminalSessionSave {
  phase: 'terminal';
  terminal: {
    iStarted: boolean;
    coinsOfInterest: CoinOfInterestEntry[];
    myAlias: string | null;
    opponentAlias: string | null;
  };
  presentation: SessionPresentationSave;
}

export type DurableSessionPhase = PreHandshakeSessionSave | LiveSessionSave | TerminalSessionSave;

export interface DurableRejectionTransport {
  kind: 'outbound-reject' | 'inbound-receipt';
  peerId: string;
  sessionId: string;
  messageNumber: bigint;
  remoteNumber: bigint;
  unackedMessages: Array<{ msgno: bigint; msg: Uint8Array }>;
  createdAt: number;
}

export function rejectionTransportKey(peerId: string, sessionId: string): string {
  return JSON.stringify([peerId, sessionId]);
}

export interface DurableApplicationState {
  schema: typeof DURABLE_APPLICATION_STATE_SCHEMA;
  version: typeof DURABLE_APPLICATION_STATE_VERSION;
  identity: SessionIdentitySave;
  preferences: SessionPreferencesSave;
  history: SessionHistorySave;
  session: DurableSessionPhase | null;
  walletContext: WalletProviderScope | null;
  channelFundingOperations: ChannelFundingEntry[];
  feeAttachments: FeeAttachment[];
  rejectionTransports: DurableRejectionTransport[];
}
