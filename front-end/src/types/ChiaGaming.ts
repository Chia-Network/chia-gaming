import { CoinRecord } from './rpc/CoinRecord';
import { Program } from 'clvm-lib';
import { jsonStringify } from '../util/jsonSafe';

export type HubLiveness = 'connected' | 'reconnecting' | 'inactive' | 'disconnected';

export type PeerLiveness = 'connected' | 'degraded' | 'dead' | null;

export type SessionPhase = 'none' | 'off-chain' | 'on-chain' | 'resolved';

interface Amount {
  amt: bigint;
}

export interface Spend {
  puzzle: string;
  solution: string;
  signature: string;
}

export interface CoinSpend {
  coin: string;
  bundle: Spend;
}

export interface SpendBundle {
  spends: CoinSpend[];
}

/** Raw per-coin chain state fed to the transaction manager's `report_coin_states`. */
export interface CoinStateRecord {
  /** Full coin string, hex-encoded. */
  coin: string;
  created_height: bigint | null;
  spent_height: bigint | null;
}

/** Wallet funding request emitted by the WASM game-session boundary. */
export interface NeedCoinSpendRequest {
  /** Exact decimal u64 emitted by WASM; never an IEEE-754 number. */
  amount: string;
  conditions: Array<{ opcode: bigint | number; args: string[] }>;
  coin_id?: string;
  max_height?: bigint | number;
}

export type GameSessionEvent =
  | { OutboundMessage: Uint8Array }
  | { OutboundTransaction: SpendBundle }
  | { Notification: WasmNotification }
  | { Log: string }
  | { CoinSolutionRequest: string }
  | { ReceiveError: string }
  | { NeedCoinSpend: NeedCoinSpendRequest }
  | { NeedLauncherCoin: boolean };

export interface WasmResult {
  events?: GameSessionEvent[];
  watchCoins?: Array<{ coin_name: string; coin_string: string }>;
  unwatchCoins?: Array<{ coin_name: string; coin_string: string }>;
  /** Whether the WASM action completed before its result was drained. */
  actionSucceeded?: boolean;
  ids?: string[];
  disposition?: WasmDisposition;
}

export type WasmDisposition =
  | { kind: 'active' }
  | { kind: 'await-outbound-terminal'; command: { id: string; message: Uint8Array } }
  | { kind: 'terminal' };

export type WasmInitFn = (opts?: {
  module_or_path?: string | URL | Request | Response | Promise<Response>;
}) => Promise<any>;

export interface CoinsetOrgBlockSpend {
  coin: { parent_coin_info: string; puzzle_hash: string; amount: bigint };
  puzzle_reveal: string;
  solution: string;
}

export interface ProposeGameParams {
  game_type: string;
  timeout: bigint;
  parameters: Program | null;
}

interface IChiaIdentity {
  private_key: string;
  synthetic_private_key: string;
  public_key: string;
  synthetic_public_key: string;
  puzzle: string;
  puzzle_hash: string;
}

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

type WasmNotificationTag =
  | 'ChannelStatus'
  | 'GameStatus'
  | 'GameSettled'
  | 'ProposalMade'
  | 'ProposalAccepted'
  | 'ProposalCancelled'
  | 'InsufficientBalance'
  | 'MoveRejected'
  | 'ActionFailed';

export type GameStatusState =
  | 'my-turn'
  | 'their-turn'
  | 'on-chain-my-turn'
  | 'on-chain-their-turn'
  | 'replaying'
  | 'playing-move'
  | 'illegal-move-detected'
  | 'ended-cancelled'
  | 'ended-error';

interface GameStatusOtherParams {
  readable?: unknown;
  mover_share?: unknown;
  illegal_move_detected?: boolean;
  moved_by_us?: boolean;
  game_finished?: boolean;
  submitting_timeout_claim?: boolean;
}

export interface GameStatusPayload {
  id: unknown;
  status: GameStatusState;
  my_reward?: unknown;
  coin_id?: unknown;
  reason?: string | null;
  other_params?: GameStatusOtherParams | null;
}

export interface GameSettledPayload {
  id: unknown;
  outcome: string;
  our_share: unknown;
  coin_id?: unknown;
}

export type ChannelStatus =
  | 'Handshaking'
  | 'WaitingForHeightToOffer'
  | 'WaitingForHeightToAccept'
  | 'OurWalletMakingOffer'
  | 'OurWalletMakingOfferAcceptance'
  | 'OfferSent'
  | 'TransactionPending'
  | 'Active'
  | 'ShuttingDown'
  | 'ShutdownTransactionPending'
  | 'GoingOnChain'
  | 'Unrolling'
  | 'ResolvedClean'
  | 'ResolvedUnrolled'
  | 'ResolvedStale'
  | 'Failed';

export type SessionDisposition = 'AwaitOutboundTerminal' | 'Abandoned';

export interface ChannelStatusPayload {
  state: ChannelStatus;
  session_disposition?: SessionDisposition | null;
  advisory: string | null;
  coin: unknown;
  our_balance: unknown;
  their_balance: unknown;
  game_allocated: unknown;
  have_potato?: boolean | null;
  zero_payout?: boolean | null;
  unroll_initiator?: 'us' | 'opponent' | null;
  semantic_phase?: ChannelSemanticPhase | null;
}

export type ChannelSemanticPhase =
  | 'submitting_channel_spend'
  | 'resolving_opponent_channel_spend'
  | 'preempting'
  | 'waiting_timeout'
  | 'submitting_timeout_finish'
  | 'resolving';

export interface ProposalAcceptedPayload {
  id: bigint | number | string;
  amount: bigint | number | string | { amt?: unknown; Amount?: unknown };
}

export interface MoveRejectedPayload {
  id: bigint | number | string;
  tag: string;
  message: string;
}

export interface ActionFailedPayload {
  id?: bigint | number | string;
  action?: 'make_move' | 'accept_settlement';
  reason: string;
}

export type WasmNotification = {
  [K in Exclude<
    WasmNotificationTag,
    'ProposalAccepted' | 'MoveRejected' | 'ActionFailed'
  >]?: Record<string, unknown>;
} & {
  ProposalAccepted?: ProposalAcceptedPayload;
  MoveRejected?: MoveRejectedPayload;
  ActionFailed?: ActionFailedPayload;
};

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
  | { type: 'address'; data: BlockchainInboundAddressResult }
  | { type: 'log'; message: string };

interface GameSessionCreateConfig {
  rng_id: number;
  have_potato: boolean;
  my_contribution: Amount;
  their_contribution: Amount;
  channel_timeout: number;
  unroll_timeout: number;
  reward_puzzle_hash: string;
}

/// A labeled coin id (hex) surfaced in the dashboard for explorer lookup.
export interface CoinOfInterestEntry {
  label: string;
  id: string;
}

export interface WasmConnection {
  // System
  init: (print: (msg: string) => void) => void;
  create_rng: (seed: string) => number;
  create_game_session: (config: GameSessionCreateConfig) => { id: number; puzzle_hash: string };
  restore_session: (serialized: Uint8Array, new_seed: string) => number;
  game_session_serialization_schema: () => number;
  cache_file: (name: string, data: Uint8Array) => void;

  // Blockchain
  set_funding_coin: (cid: number, coinstring: string) => WasmResult | undefined;
  start_handshake: (cid: number) => WasmResult | undefined;
  provide_launcher_coin: (cid: number, hex_launcher_coin: string) => WasmResult | undefined;
  provide_coin_spend_bundle: (cid: number, bundle_json: string) => WasmResult | undefined;
  provide_offer_bech32: (cid: number, offer_bech32: string) => WasmResult | undefined;
  wallet_callback_failed: (cid: number, reason: string) => WasmResult | undefined;
  get_channel_puzzle_hash: (cid: number) => string | null;
  new_block: (
    cid: number,
    height: bigint,
    additions: string[],
    removals: string[],
  ) => WasmResult | undefined;
  report_coin_states: (cid: number, height: bigint, records_json: string) => WasmResult | undefined;
  report_height: (cid: number, height: bigint) => WasmResult | undefined;
  snapshot_watched_coins: (cid: number) => Array<{ coin_name: string; coin_string: string }>;
  drain_submissions: (cid: number) => SpendBundle[];
  resubmit_submitted: (cid: number) => void;
  convert_coinset_org_block_spend_to_watch_report: (
    parent_coin_info: string,
    puzzle_hash: string,
    amount: string,
    puzzle_reveal: string,
    solution: string,
  ) => WatchReport | undefined;
  convert_spend_to_coinset_org: (spend: string) => unknown;
  convert_offer_to_coinset_org: (offer: string) => unknown;
  convert_coinset_to_coin_string: (
    parent_coin_info: string,
    puzzle_hash: string,
    amount: string,
  ) => string;
  convert_chia_public_key_to_puzzle_hash: (public_key: string) => string;
  coin_string_to_name: (hex_coinstring: string) => string;

  // Game
  propose_games: (
    cid: number,
    games: Omit<ProposeGameParams, 'parameters'>[],
    parameters_list: Uint8Array[],
  ) => WasmResult | undefined;
  accept_proposal: (cid: number, game_id: string) => WasmResult | undefined;
  accept_proposal_and_move: (
    cid: number,
    id: string,
    readable: Uint8Array,
  ) => WasmResult | undefined;
  cancel_proposal: (cid: number, game_id: string) => WasmResult | undefined;
  make_move_with_entropy_for_testing: (
    cid: number,
    id: string,
    readable: Uint8Array,
    new_entropy: string,
  ) => WasmResult | undefined;
  make_move: (cid: number, id: string, readable: Uint8Array) => WasmResult | undefined;
  cheat: (cid: number, id: string, mover_share: string) => WasmResult | undefined;
  accept_settlement: (cid: number, id: string) => WasmResult | undefined;
  shut_down: (cid: number) => WasmResult | undefined;
  abandon: (cid: number) => WasmResult | undefined;
  complete_outbound_terminal_handoff: (cid: number) => WasmResult | undefined;
  pending_terminal_handoff: (cid: number) => { id: string; message: Uint8Array } | null;
  go_on_chain: (cid: number) => WasmResult | undefined;
  report_puzzle_and_solution: (
    cid: number,
    coin_hex: string,
    puzzle_hex: string | undefined,
    solution_hex: string | undefined,
  ) => WasmResult | undefined;
  deliver_message: (cid: number, inbound_message: Uint8Array) => WasmResult | undefined;
  game_session_amount: (cid: number) => bigint;
  game_session_our_share: (cid: number) => bigint;
  game_session_their_share: (cid: number) => bigint;
  get_identity: (cid: number) => IChiaIdentity;
  get_game_state_id: (cid: number) => string | undefined;
  protocol_state_pretty: (cid: number) => string;
  historical_unroll_count: (cid: number) => number | undefined;
  coins_of_interest: (cid: number) => CoinOfInterestEntry[];
  serialize_game_session: (cid: number) => Uint8Array;
  get_watching_coins: (cid: number) => Array<{ coin_name: string; coin_string: string }>;

  // Misc
  sha256bytes: (hex: string) => string;
}

export class ChiaGame {
  wasm: WasmConnection;
  waiting_messages: Uint8Array[];
  session: number;

  constructor(wasm: WasmConnection, sessionId: number) {
    this.wasm = wasm;
    this.waiting_messages = [] as Uint8Array[];
    this.session = sessionId;
  }

  propose_games(
    games: Omit<ProposeGameParams, 'parameters'>[],
    parameters_list: Uint8Array[],
  ): WasmResult | undefined {
    return this.wasm.propose_games(this.session, games, parameters_list);
  }

  accept_proposal(game_id: string): WasmResult | undefined {
    return this.wasm.accept_proposal(this.session, game_id);
  }

  accept_proposal_and_move(game_id: string, readable: Uint8Array): WasmResult | undefined {
    return this.wasm.accept_proposal_and_move(this.session, game_id, readable);
  }

  cancel_proposal(game_id: string): WasmResult | undefined {
    return this.wasm.cancel_proposal(this.session, game_id);
  }

  amount(): bigint {
    return BigInt(this.wasm.game_session_amount(this.session));
  }

  our_share(): bigint {
    return BigInt(this.wasm.game_session_our_share(this.session));
  }

  their_share(): bigint {
    return BigInt(this.wasm.game_session_their_share(this.session));
  }

  get_game_state_id(): string | undefined {
    return this.wasm.get_game_state_id(this.session);
  }

  protocol_state_pretty(): string {
    return this.wasm.protocol_state_pretty(this.session);
  }

  historical_unroll_count(): bigint | undefined {
    const count = this.wasm.historical_unroll_count(this.session);
    return count === undefined ? undefined : BigInt(count);
  }

  coins_of_interest(): CoinOfInterestEntry[] {
    return this.wasm.coins_of_interest(this.session);
  }

  serialize(): Uint8Array {
    return this.wasm.serialize_game_session(this.session);
  }

  get_watching_coins(): Array<{ coin_name: string; coin_string: string }> {
    return this.wasm.get_watching_coins(this.session);
  }

  acceptSettlement(id: string): WasmResult | undefined {
    return this.wasm.accept_settlement(this.session, id);
  }

  shut_down(): WasmResult | undefined {
    return this.wasm.shut_down(this.session);
  }

  abandon(): WasmResult | undefined {
    return this.wasm.abandon(this.session);
  }

  completeOutboundTerminalHandoff(): WasmResult | undefined {
    return this.wasm.complete_outbound_terminal_handoff(this.session);
  }

  pendingTerminalHandoff(): { id: string; message: Uint8Array } | null {
    return this.wasm.pending_terminal_handoff(this.session);
  }

  go_on_chain(): WasmResult | undefined {
    return this.wasm.go_on_chain(this.session);
  }

  report_puzzle_and_solution(
    coin_hex: string,
    puzzle_hex: string | undefined,
    solution_hex: string | undefined,
  ): WasmResult | undefined {
    return this.wasm.report_puzzle_and_solution(this.session, coin_hex, puzzle_hex, solution_hex);
  }

  make_move(id: string, readable: Uint8Array): WasmResult | undefined {
    return this.wasm.make_move(this.session, id, readable);
  }

  make_move_with_entropy_for_testing(
    id: string,
    readable: Uint8Array,
    new_entropy: string,
  ): WasmResult | undefined {
    return this.wasm.make_move_with_entropy_for_testing(this.session, id, readable, new_entropy);
  }

  cheat(game_id: string, mover_share: bigint): WasmResult | undefined {
    return this.wasm.cheat(this.session, game_id, String(mover_share));
  }

  deliver_message(msg: Uint8Array): WasmResult | undefined {
    return this.wasm.deliver_message(this.session, msg);
  }

  set_funding_coin(coin_string: string): WasmResult | undefined {
    return this.wasm.set_funding_coin(this.session, coin_string);
  }

  start_handshake(): WasmResult | undefined {
    const maybeStart = (
      this.wasm as unknown as { start_handshake?: (cid: number) => WasmResult | undefined }
    ).start_handshake;
    if (typeof maybeStart !== 'function') return undefined;
    return maybeStart(this.session);
  }

  provide_launcher_coin(hex_launcher_coin: string): WasmResult | undefined {
    const maybeProvide = (
      this.wasm as unknown as {
        provide_launcher_coin?: (cid: number, coin: string) => WasmResult | undefined;
      }
    ).provide_launcher_coin;
    if (typeof maybeProvide !== 'function') return undefined;
    return maybeProvide(this.session, hex_launcher_coin);
  }

  provide_coin_spend_bundle(bundle_json: string): WasmResult | undefined {
    const maybeProvide = (
      this.wasm as unknown as {
        provide_coin_spend_bundle?: (cid: number, bundle: string) => WasmResult | undefined;
      }
    ).provide_coin_spend_bundle;
    if (typeof maybeProvide !== 'function') return undefined;
    return maybeProvide(this.session, bundle_json);
  }

  provide_offer_bech32(offer_bech32: string): any {
    return this.wasm.provide_offer_bech32(this.session, offer_bech32);
  }

  wallet_callback_failed(reason: string): WasmResult | undefined {
    const maybeFail = (
      this.wasm as unknown as {
        wallet_callback_failed?: (cid: number, reason: string) => WasmResult | undefined;
      }
    ).wallet_callback_failed;
    if (typeof maybeFail !== 'function') return undefined;
    return maybeFail(this.session, reason);
  }

  get_channel_puzzle_hash(): string | null {
    const maybeGet = (
      this.wasm as unknown as { get_channel_puzzle_hash?: (cid: number) => string | null }
    ).get_channel_puzzle_hash;
    if (typeof maybeGet !== 'function') return null;
    return maybeGet(this.session);
  }

  /** Report raw per-coin chain state; the manager computes the diff internally. */
  report_coin_states(height: bigint, records: CoinStateRecord[]): WasmResult | undefined {
    return this.wasm.report_coin_states(this.session, height, jsonStringify(records));
  }

  /** Advance protocol clocks without treating absent coin data as a snapshot. */
  report_height(height: bigint): WasmResult | undefined {
    return this.wasm.report_height(this.session, height);
  }

  /** Durable watched-coin snapshot used to seed host polling after attach/restore. */
  snapshot_watched_coins(): Array<{ coin_name: string; coin_string: string }> {
    return this.wasm.snapshot_watched_coins(this.session);
  }

  /** Spend bundles the manager captured and the host should submit. */
  drain_submissions(): SpendBundle[] {
    return this.wasm.drain_submissions(this.session);
  }

  /** Re-queue all retained submissions for resubmission (call after reload). */
  resubmit_submitted(): void {
    this.wasm.resubmit_submitted(this.session);
  }
}

export class RngId {
  rngId: number;
  constructor(rngId: number) {
    this.rngId = rngId;
  }
  getId() {
    return this.rngId;
  }
}

export interface WatchReport {
  created_watched: string[];
  deleted_watched: string[];
}

export interface PeerConnectionResult {
  /** Returns false when the hub WS is not OPEN (frame was not sent). */
  sendMessage: (msgno: number, input: Uint8Array) => boolean;
  /** Returns false when the hub WS is not OPEN (frame was not sent). */
  sendAck: (ackMsgno: number) => boolean;
  /** Returns false when the hub WS is not OPEN. */
  sendKeepalive: () => boolean;
  hostLog: (msg: string) => void;
  close: () => void;
}

export interface BlockchainReport {
  peak: bigint;
  block: CoinsetOrgBlockSpend[] | undefined;
  report: WatchReport | undefined;
}

export interface BlockchainInboundAddressResult {
  puzzleHash: string;
}

export interface ConnectionField {
  label: string;
  default: bigint;
}

export interface ConnectionSetup {
  qrUri: string;
  skipQr?: boolean;
  fields?: { balance?: ConnectionField };
  finalize(values?: { balance?: bigint }): Promise<void>;
}

export interface InternalBlockchainInterface {
  requestGapMs?: number;
  getRegistrationScopeKey?(): string | undefined;
  spend(
    blob: string,
    spendBundle: unknown,
    changePuzzleHash: string,
    source?: string,
    fee?: bigint,
  ): Promise<string>;
  rememberLocalRemovals?(spendBundle: unknown): void | Promise<void>;
  getAddress(): Promise<BlockchainInboundAddressResult>;
  getBalance(): Promise<bigint>;
  getPuzzleAndSolution(coin: string): Promise<string[] | null>;
  selectCoins(uniqueId: string, amount: bigint): Promise<string | null>;
  getHeightInfo(): Promise<bigint>;
  createOfferForIds(
    uniqueId: string,
    offer: { [walletId: string]: bigint },
    extraConditions?: Array<{ opcode: bigint; args: string[] }>,
    coinIds?: string[],
    maxHeight?: bigint,
  ): Promise<any | null>;
  getCoinRecordsByNames(names: string[]): Promise<CoinRecord[]>;
  registerCoins(names: string[]): Promise<void>;
  startMonitoring(): Promise<void>;

  beginConnect(uniqueId: string, fresh?: boolean): Promise<ConnectionSetup>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  onConnectionChange(cb: (connected: boolean) => void): () => void;
}
