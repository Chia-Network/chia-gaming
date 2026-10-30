import { CoinRecord } from './rpc/CoinRecord';
import type * as WasmContract from '../../../wasm/contract';

export type ProtocolGameId = WasmContract.ProtocolGameId;

export type HubLiveness = 'connected' | 'reconnecting' | 'inactive' | 'disconnected';

export type PeerLiveness = 'connected' | 'degraded' | 'dead' | null;

export type SessionPhase = 'none' | 'off-chain' | 'on-chain' | 'resolved';

export type Spend = WasmContract.Spend;
export type CoinSpend = WasmContract.CoinSpend;
export type SpendBundle = WasmContract.SpendBundle;

/** Raw per-coin chain state fed to the transaction manager's `report_coin_states`. */
export type CoinStateRecord = WasmContract.CoinStateRecord;

/** Wallet funding request emitted by the WASM game-session boundary. */
export type NeedCoinSpendRequest = WasmContract.NeedCoinSpendRequest;
export type GameSessionEvent = WasmContract.GameSessionEvent;
export type WasmResult = WasmContract.WasmResult;
export type WasmDisposition = WasmContract.WasmDisposition;

const WASM_NOTIFICATION_TAGS = new Set([
  'ChannelStatus',
  'GameStatus',
  'GameSettled',
  'ProposalMade',
  'ProposalAcceptedGroup',
  'ProposalCancelled',
  'InsufficientBalance',
  'MoveRejected',
  'ActionFailed',
  'LocalActionApplied',
]);

function requireClosedNotification(value: unknown): void {
  if (typeof value !== 'object' || value === null) {
    throw new Error('cradle returned a non-object notification');
  }
  const tags = Object.keys(value);
  if (tags.length !== 1 || !WASM_NOTIFICATION_TAGS.has(tags[0])) {
    throw new Error(`cradle returned an unknown notification: ${tags.join(',') || '(empty)'}`);
  }
}

function requireGameSessionEvent(event: unknown): void {
  if (typeof event !== 'object' || event === null) {
    throw new Error('cradle returned a non-object GameSessionEvent');
  }
  const keys = Object.keys(event);
  if (keys.length !== 1) {
    throw new Error('cradle returned a malformed GameSessionEvent');
  }
  const key = keys[0];
  const payload = (event as Record<string, unknown>)[key];
  switch (key) {
    case 'OutboundMessage':
      if (!(payload instanceof Uint8Array)) {
        throw new Error('cradle returned a non-byte OutboundMessage');
      }
      return;
    case 'Notification':
      requireClosedNotification(payload);
      return;
    case 'Log':
    case 'CoinSolutionRequest':
    case 'ReceiveError':
      if (typeof payload !== 'string') {
        throw new Error(`cradle returned an invalid ${key} event`);
      }
      return;
    case 'NeedCoinSpend':
      if (typeof payload !== 'object' || payload === null) {
        throw new Error('cradle returned an invalid NeedCoinSpend event');
      }
      return;
    case 'ChannelCoinConfirmed':
    case 'ChannelCreationTimedOut':
      if (payload !== null) {
        throw new Error(`cradle returned an invalid ${key} event`);
      }
      return;
    default:
      throw new Error(`cradle returned an unknown GameSessionEvent: ${key}`);
  }
}

export function requireWasmResult(value: WasmResult | undefined): WasmResult {
  if (value === undefined || typeof value !== 'object' || value === null) {
    throw new Error('cradle returned no WasmResult');
  }
  if (
    !Array.isArray(value.events) ||
    !Array.isArray(value.watchCoins) ||
    !Array.isArray(value.unwatchCoins) ||
    typeof value.actionSucceeded !== 'boolean'
  ) {
    throw new Error('cradle returned an incomplete WasmResult');
  }
  value.events.forEach(requireGameSessionEvent);
  const disposition = value.disposition;
  if (
    typeof disposition !== 'object' ||
    disposition === null ||
    !['active', 'await-outbound-terminal', 'terminal'].includes(disposition.kind)
  ) {
    throw new Error('cradle returned an invalid WasmResult disposition');
  }
  if (
    disposition.kind === 'await-outbound-terminal' &&
    (typeof disposition.command !== 'object' ||
      disposition.command === null ||
      typeof disposition.command.id !== 'string' ||
      !(disposition.command.message instanceof Uint8Array))
  ) {
    throw new Error('cradle returned an invalid terminal handoff command');
  }
  return value;
}

export type WasmInitFn = (opts?: {
  module_or_path?: string | URL | Request | Response | Promise<Response>;
}) => Promise<any>;

export interface CoinsetOrgBlockSpend {
  coin: { parent_coin_info: string; puzzle_hash: string; amount: bigint };
  puzzle_reveal: string;
  solution: string;
}

export type ProposeGameParams = WasmContract.ProposeGameParams;

export interface GameConnectionState {
  stateIdentifier: StateIdentifier;
  stateDetail: string[];
}

type StateIdentifier = 'starting' | 'running';

export interface GameSessionParams {
  iStarted: boolean;
  myContribution: bigint; // my share of the channel
  theirContribution: bigint; // opponent's share of the channel
  perGameAmount: bigint; // mojos per hand
  restoring?: boolean;
  pairingToken?: string;
  myAlias?: string;
  opponentAlias?: string;
  channelTimeout?: bigint; // blocks, for channel coin
  unrollTimeout?: bigint; // blocks, for unroll coin
}

export type GameStatusState = WasmContract.GameStatusState;
export type GameStatusPayload = WasmContract.GameStatusPayload;
export type GameSettledPayload = WasmContract.GameSettledPayload;
export type ChannelStatus = WasmContract.ChannelStatus;
export type SessionDisposition = WasmContract.SessionDisposition;
export type ChannelStatusPayload = WasmContract.ChannelStatusPayload;

export const CHANNEL_SEMANTIC_PHASES = [
  'submitting_channel_spend',
  'unrolling',
  'finding_state',
  'preempting',
  'finishing_waiting_timeout',
  'finishing_spending',
  'resolving',
] as const;

export type ChannelSemanticPhase = WasmContract.ChannelSemanticPhase;
export type ProposalAcceptedGroupPayload = WasmContract.ProposalAcceptedGroupPayload;
export type ProposalMadePayload = WasmContract.ProposalMadePayload;
export type MoveRejectedPayload = WasmContract.MoveRejectedPayload;
export type ActionFailedPayload = WasmContract.ActionFailedPayload;
export type WasmNotification = WasmContract.WasmNotification;

export type WasmEvent =
  | { type: 'notification'; data: WasmNotification }
  | { type: 'error'; error: string }
  | {
      type: 'game-action-error';
      gameId: string;
      action: 'make-move' | 'accept-settlement';
      error: string;
    }
  | { type: 'durability-error'; error: string }
  | {
      type: 'recoverable-internal-error';
      error: string;
      failure: SubmissionDrainFailure;
    }
  | { type: 'address'; data: BlockchainInboundAddressResult }
  | { type: 'log'; message: string };

/// A labeled coin id (hex) surfaced in the dashboard for explorer lookup.
export type CoinOfInterestEntry = WasmContract.CoinOfInterestEntry;

export type TransactionSubmission = WasmContract.TransactionSubmission;
export type SubmissionDrainFailureStage = WasmContract.SubmissionDrainFailureStage;
export type SubmissionDrainFailure = WasmContract.SubmissionDrainFailure;
export type SubmissionDrain = WasmContract.SubmissionDrain;

export type FinalizedSubmission = WasmContract.FinalizedSubmission;

export type SubmissionAttemptStatus = WasmContract.SubmissionAttemptStatus;
export type SubmissionFinalizationResult = WasmContract.SubmissionFinalizationResult;

export type WalletSubmitOutcome =
  | { status: 'acknowledged'; detail?: string }
  | { status: 'unavailable'; detail: string }
  | { status: 'rejected'; detail: string };

export type WalletOfferOperation = {
  owner: {
    installationPlayerId: string;
    peerSessionId: string;
    providerScope: WalletProviderScope;
  };
  purpose: { kind: 'funding'; operationId: string } | { kind: 'fee'; operationId: string };
};

export type WalletProviderScope =
  | { provider: 'cloud'; walletId: string }
  | { provider: 'walletconnect'; fingerprint: string; chainId: string }
  | { provider: 'simulator'; identity: string };

export type WalletOfferRequest =
  | {
      kind: 'funding';
      uniqueId: string;
      offer: { [walletId: string]: bigint };
      extraConditions?: Array<{ opcode: bigint; args: string[] }>;
      coinIds?: string[];
      maxHeight?: bigint;
      openingFee?: bigint;
    }
  | {
      kind: 'fee';
      uniqueId: string;
      fee: bigint;
      concurrentSpendCoinId: string;
    };

export type WalletOfferMaterial =
  { kind: 'offer'; offer: string } | { kind: 'bundle'; bundle: unknown };

export type WalletOfferReservedCompletion = {
  kind: 'created-reserved';
  material: WalletOfferMaterial;
  tradeId: string;
  warning?: string;
};

export type WalletOfferEphemeralCompletion = {
  kind: 'created-ephemeral';
  material: WalletOfferMaterial;
  warning?: string;
};

export type WalletOfferCompletion =
  | WalletOfferReservedCompletion
  | WalletOfferEphemeralCompletion
  | { kind: 'failure'; reason: string }
  | { kind: 'unavailable'; reason: string };

export type WalletOfferBeginOutcome =
  WalletOfferCompletion | { kind: 'pending'; recoveryId: string };

export interface WasmConnection {
  create_peer_protocol: import('../services/peerProtocol').PeerProtocolFactory;
  init: () => void;
  game_session_serialization_schema: () => number;
  cache_file: (name: string, data: Uint8Array) => void;
  registered_game_packages: () => Array<{ key: string; id: string }>;
  convert_spend_to_coinset_org: (spend: string) => unknown;
  convert_offer_to_coinset_org: (offer: string) => unknown;
  convert_coinset_to_coin_string: (
    parent_coin_info: string,
    puzzle_hash: string,
    amount: string,
  ) => string;
  convert_chia_public_key_to_puzzle_hash: (public_key: string) => string;
  sha256bytes: (hex: string) => string;
}

export type ChiaGame = WasmContract.GameSessionApi;

export interface WatchReport {
  created_watched: string[];
  deleted_watched: string[];
}

export interface PeerConnectionResult {
  /**
   * Shared durable reliability state. Real browser peer sessions expose this
   * object before negotiation and SessionController continues using the same
   * object after acceptance.
   */
  reliableState?: {
    sessionId: string;
    messageNumber: bigint;
    remoteNumber: bigint;
    unackedMessages: Array<{ msgno: bigint; msg: Uint8Array }>;
    disposition: 'active' | 'proposal-received' | 'outbound-reject' | 'inbound-reject';
  };
  reliableTransport?: unknown;
  persistInboundSessionReject?: (sessionId: string, remoteNumber: bigint) => Promise<void>;
  onSessionReject?: (sessionId: string, remoteNumber: bigint) => void;
  /** Returns false when the hub WS is not OPEN (frame was not sent). */
  sendMessage: (msgno: number, input: Uint8Array) => boolean;
  /** Returns false when the hub WS is not OPEN (frame was not sent). */
  sendAck: (ackMsgno: number) => boolean;
  /** Returns false when the hub WS is not OPEN. */
  sendKeepalive: () => boolean;
  hostLog: (msg: string) => void;
  close: () => void;
  receivePolicy?: import('../lib/session/receivePolicy').ReadonlySessionReceivePolicy;
}

export interface BlockchainReport {
  peak: bigint;
  block: CoinsetOrgBlockSpend[] | undefined;
  report: WatchReport | undefined;
}

export interface BlockchainInboundAddressResult {
  puzzleHash: string;
  // The wallet-provided bech32m address string carrying the correct network HRP
  // (e.g. txch on testnet). Used verbatim as the fee-spend destination so the
  // wallet's send_transaction address validation matches its configured network.
  // Optional: backends that only surface a puzzle hash may omit it.
  address?: string;
}

export type ConnectionField =
  | { type: 'bigint'; label: string; default: bigint }
  | { type: 'string'; label: string; default: string };

export type ConnectionFieldValues = Record<string, string | bigint>;

export interface ConnectionSetup {
  qrUri: string;
  skipQr?: boolean;
  title?: string;
  description?: string;
  fields?: Record<string, ConnectionField>;
  finalize(values?: ConnectionFieldValues): Promise<void>;
}

export type WalletOfferCancellationOutcome =
  | { status: 'cancelled'; detail?: string }
  | { status: 'already-terminal'; detail: string }
  | { status: 'unavailable'; detail: string }
  | { status: 'rejected'; detail: string };

export type WalletOfferCancellationBeginOutcome =
  WalletOfferCancellationOutcome | { status: 'pending'; recoveryId: string };

interface WalletOfferProviderBase {
  readonly scope: WalletProviderScope;
}

export interface BestEffortWalletOfferProvider extends WalletOfferProviderBase {
  readonly capability: 'best-effort';
  beginCreation(
    operation: WalletOfferOperation,
    request: WalletOfferRequest,
  ): Promise<Exclude<WalletOfferCompletion, WalletOfferEphemeralCompletion>>;
  cancel(tradeId: string): Promise<WalletOfferCancellationOutcome>;
}

export interface TerminalWalletOfferProvider extends WalletOfferProviderBase {
  readonly capability: 'terminal';
  beginCreation(
    operation: WalletOfferOperation,
    request: WalletOfferRequest,
  ): Promise<WalletOfferCompletion>;
  cancel(tradeId: string): Promise<WalletOfferCancellationOutcome>;
}

export interface RecoverableWalletOfferProvider extends WalletOfferProviderBase {
  readonly capability: 'recoverable';
  beginCreation(
    operation: WalletOfferOperation,
    request: WalletOfferRequest,
  ): Promise<Exclude<WalletOfferBeginOutcome, WalletOfferEphemeralCompletion>>;
  reconcileCreation(
    operation: WalletOfferOperation,
    request: WalletOfferRequest,
    recoveryId: string,
  ): Promise<Exclude<WalletOfferCompletion, WalletOfferEphemeralCompletion>>;
  beginCancellation(tradeId: string): Promise<WalletOfferCancellationBeginOutcome>;
  reconcileCancellation(
    tradeId: string,
    recoveryId: string,
  ): Promise<WalletOfferCancellationOutcome>;
}

/**
 * Provider whose mutation is exactly recoverable only after its begin response
 * supplies a provider recovery id. Transport loss before that response remains
 * best-effort uncertainty.
 */
export interface RecoverableAfterBeginWalletOfferProvider extends WalletOfferProviderBase {
  readonly capability: 'recoverable-after-begin';
  beginCreation(
    operation: WalletOfferOperation,
    request: WalletOfferRequest,
  ): Promise<Exclude<WalletOfferBeginOutcome, WalletOfferEphemeralCompletion>>;
  reconcileCreation(
    operation: WalletOfferOperation,
    request: WalletOfferRequest,
    recoveryId: string,
  ): Promise<Exclude<WalletOfferCompletion, WalletOfferEphemeralCompletion>>;
  beginCancellation(tradeId: string): Promise<WalletOfferCancellationBeginOutcome>;
  reconcileCancellation(
    tradeId: string,
    recoveryId: string,
  ): Promise<WalletOfferCancellationOutcome>;
}

export type WalletOfferProvider =
  | BestEffortWalletOfferProvider
  | TerminalWalletOfferProvider
  | RecoverableWalletOfferProvider
  | RecoverableAfterBeginWalletOfferProvider;

export interface InternalBlockchainInterface {
  requestGapMs?: number;
  fundingMode?: 'offer-settlement';
  getWalletOfferProvider(
    owner?: Pick<WalletOfferOperation['owner'], 'installationPlayerId' | 'peerSessionId'>,
  ): WalletOfferProvider | null;
  getRegistrationScopeKey?(): string | undefined;
  spend(
    blob: string,
    spendBundle: unknown,
    changePuzzleHash: string,
    source?: string,
    fee?: bigint,
  ): Promise<WalletSubmitOutcome>;
  getAddress(): Promise<BlockchainInboundAddressResult>;
  getBalance(): Promise<bigint>;
  getPuzzleAndSolution(coin: string): Promise<string[] | null>;
  selectCoins(uniqueId: string, amount: bigint): Promise<string | null>;
  getHeightInfo(): Promise<bigint>;
  getCoinRecordsByNames(names: string[]): Promise<CoinRecord[]>;
  registerCoins(names: string[]): Promise<void>;
  startMonitoring(): Promise<void>;

  beginConnect(uniqueId: string, fresh?: boolean): Promise<ConnectionSetup>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  // Recovery pauses RPCs without revoking the approved wallet connection.
  onConnectionChange(cb: (connected: boolean, recovering?: boolean) => void): () => void;
  // True when this backend can fund/resolve channels (hub may advertise
  // not-busy). Simulator and Cloud Wallet: ready whenever connected.
  // WalletConnect: ready once a full-node peer is verified when the wallet
  // supports that optional RPC, otherwise ready whenever connected.
  isReadyForPlay(): boolean;
  onPlayReadinessChange(cb: (ready: boolean) => void): () => void;
}
