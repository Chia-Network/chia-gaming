import { CoinRecord } from './rpc/CoinRecord';
import { Program } from 'clvm-lib';
import { jsonStringify } from '../util/jsonSafe';

function cardIdToRankSuit(cardId: bigint | number): { rank: number; suit: number } {
  const id = typeof cardId === 'bigint' ? Number(cardId) : cardId;
  return { rank: Math.floor(id / 4) + 2, suit: (id % 4) + 1 };
}

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

export type GameSessionEvent =
  | { OutboundMessage: Uint8Array }
  | { OutboundTransaction: SpendBundle }
  | { Notification: WasmNotification }
  | { Log: string }
  | { CoinSolutionRequest: string }
  | { ReceiveError: string }
  | { NeedCoinSpend: {
      amount: bigint;
      conditions: Array<{ opcode: bigint; args: string[] }>;
      coin_id?: string;
      max_height?: bigint;
    } }
  | { NeedLauncherCoin: boolean };

export interface WasmResult {
  events?: GameSessionEvent[];
  watchCoins?: Array<{ coin_name: string; coin_string: string }>;
  ids?: string[];
  terminal?: boolean;
}

export type WasmInitFn = (opts?: { module_or_path?: string | URL | Request | Response | Promise<Response> }) => Promise<any>;

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
  myContribution: bigint;      // my share of the channel
  theirContribution: bigint;   // opponent's share of the channel
  perGameAmount: bigint;       // mojos per hand
  restoring?: boolean;
  pairingToken?: string;
  myAlias?: string;
  opponentAlias?: string;
  channelTimeout?: bigint;     // blocks, for channel coin
  unrollTimeout?: bigint;      // blocks, for unroll coin
}

type WasmNotificationTag =
  | 'ChannelStatus'
  | 'GameStatus'
  | 'GameSettled'
  | 'ProposalMade' | 'ProposalAccepted' | 'ProposalCancelled'
  | 'InsufficientBalance'
  | 'MoveRejected'
  | 'ActionFailed';

export type GameStatusState =
  | 'my-turn'
  | 'their-turn'
  | 'on-chain-my-turn'
  | 'on-chain-their-turn'
  | 'replaying'
  | 'illegal-move-detected'
  | 'ended-cancelled'
  | 'ended-error';

interface GameStatusOtherParams {
  readable?: unknown;
  mover_share?: unknown;
  illegal_move_detected?: boolean;
  moved_by_us?: boolean;
  game_finished?: boolean;
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
  | 'Handshaking' | 'WaitingForHeightToOffer' | 'WaitingForHeightToAccept'
  | 'OurWalletMakingOffer' | 'OurWalletMakingOfferAcceptance' | 'OfferSent' | 'TransactionPending'
  | 'Active' | 'ShuttingDown' | 'ShutdownTransactionPending'
  | 'GoingOnChain' | 'Unrolling'
  | 'ResolvedClean' | 'DoneUnrolling' | 'ResolvedStale'
  | 'Failed';

export interface ChannelStatusPayload {
  state: ChannelStatus;
  advisory: string | null;
  coin: unknown;
  our_balance: unknown;
  their_balance: unknown;
  game_allocated: unknown;
  have_potato?: boolean | null;
}

export interface ProposalAcceptedPayload {
  id: bigint | number | string;
  amount: bigint | number | string | { amt?: unknown; Amount?: unknown };
}

export interface MoveRejectedPayload {
  id: bigint | number | string;
  tag: string;
  message: string;
}

export type WasmNotification = {
  [K in Exclude<WasmNotificationTag, 'ProposalAccepted' | 'MoveRejected'>]?: Record<string, unknown>;
} & {
  ProposalAccepted?: ProposalAcceptedPayload;
  MoveRejected?: MoveRejectedPayload;
};

export type WasmEvent =
  | { type: 'notification'; data: WasmNotification }
  | { type: 'error'; error: string }
  | { type: 'durability-error'; error: string }
  | { type: 'address'; data: BlockchainInboundAddressResult }
  | { type: 'log'; message: string }
  | { type: 'terminal' };

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
  propose_games: (cid: number, games: Omit<ProposeGameParams, 'parameters'>[], parameters_list: Uint8Array[]) => WasmResult | undefined;
  accept_proposal: (cid: number, game_id: string) => WasmResult | undefined;
  accept_proposal_and_move: (cid: number, id: string, readable: Uint8Array) => WasmResult | undefined;
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

  constructor(
    wasm: WasmConnection,
    sessionId: number,
  ) {
    this.wasm = wasm;
    this.waiting_messages = [] as Uint8Array[];
    this.session = sessionId;
  }

  propose_games(games: Omit<ProposeGameParams, 'parameters'>[], parameters_list: Uint8Array[]): WasmResult | undefined {
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

  make_move_with_entropy_for_testing(id: string, readable: Uint8Array, new_entropy: string): WasmResult | undefined {
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
      this.wasm as unknown as { provide_launcher_coin?: (cid: number, coin: string) => WasmResult | undefined }
    ).provide_launcher_coin;
    if (typeof maybeProvide !== 'function') return undefined;
    return maybeProvide(this.session, hex_launcher_coin);
  }

  provide_coin_spend_bundle(bundle_json: string): WasmResult | undefined {
    const maybeProvide = (
      this.wasm as unknown as { provide_coin_spend_bundle?: (cid: number, bundle: string) => WasmResult | undefined }
    ).provide_coin_spend_bundle;
    if (typeof maybeProvide !== 'function') return undefined;
    return maybeProvide(this.session, bundle_json);
  }

  provide_offer_bech32(offer_bech32: string): any {
    return this.wasm.provide_offer_bech32(this.session, offer_bech32);
  }

  wallet_callback_failed(reason: string): WasmResult | undefined {
    const maybeFail = (
      this.wasm as unknown as { wallet_callback_failed?: (cid: number, reason: string) => WasmResult | undefined }
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

  /**
   * Advance to `height` with no coin-state change (an empty created/deleted
   * delta).  Lets the host deliver a height tick promptly -- driving the
   * handshake's `new_block(height)` -- without waiting on the slower full
   * coin-records snapshot reported via `report_coin_states`.  Safe regardless of
   * which coins exist on chain: an empty delta forwards no coin changes, so it
   * can never be misread as a coin deletion.
   */
  new_block(height: bigint): WasmResult | undefined {
    return this.wasm.new_block(this.session, height, [], []);
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

function select_cards_using_bits<T>(card: T[], mask: bigint): T[][] {
  const result0: T[] = [];
  const result1: T[] = [];
  card.forEach((c, i) => {
    if ((mask & (1n << BigInt(i))) !== 0n) {
      result1.push(c);
    } else {
      result0.push(c);
    }
  });
  return [result0, result1];
}

function compare_card(a: bigint, b: bigint): number {
  const aRankSuit = cardIdToRankSuit(a);
  const bRankSuit = cardIdToRankSuit(b);
  const rankdiff = aRankSuit.rank - bRankSuit.rank;
  if (rankdiff === 0) {
    return aRankSuit.suit - bRankSuit.suit;
  }
  return rankdiff;
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

export class CalpokerOutcome {
  alice_discards: bigint;
  bob_discards: bigint;

  alice_selects: bigint;
  bob_selects: bigint;

  alice_hand_value: bigint[];
  bob_hand_value: bigint[];

  win_direction: bigint;
  my_win_outcome: 'win' | 'lose' | 'tie';

  alice_cards: bigint[];
  bob_cards: bigint[];

  alice_final_hand: bigint[];
  bob_final_hand: bigint[];

  alice_used_cards: bigint[];
  bob_used_cards: bigint[];

  my_cards: bigint[];
  their_cards: bigint[];
  my_final_hand: bigint[];
  their_final_hand: bigint[];
  my_used_cards: bigint[];
  their_used_cards: bigint[];
  my_hand_value: bigint[];
  their_hand_value: bigint[];

  constructor(
    iStarted: boolean,
    myDiscards: bigint,
    alice_cards: bigint[],
    bob_cards: bigint[],
    readableBytes: Uint8Array | number[],
  ) {
    const program = Program.deserialize(Uint8Array.from(readableBytes));
    const result_list = program.toList();
    this.alice_cards = alice_cards;
    this.bob_cards = bob_cards;

    this.alice_selects = result_list[1].toBigInt();
    this.bob_selects = result_list[2].toBigInt();
    this.alice_hand_value = result_list[3].toList().map(v => v.toBigInt());
    this.bob_hand_value = result_list[4].toList().map(v => v.toBigInt());
    let raw_win_direction = result_list[5].toBigInt();
    if (iStarted) {
      raw_win_direction *= -1n;
      this.alice_discards = result_list[0].toBigInt();
      this.bob_discards = myDiscards;
    } else {
      this.alice_discards = myDiscards;
      this.bob_discards = result_list[0].toBigInt();
    }

    this.win_direction = raw_win_direction;
    const alice_win = this.win_direction < 0n;

    if (this.win_direction === 0n) {
      this.my_win_outcome = 'tie';
    } else if (alice_win) {
      this.my_win_outcome = iStarted ? 'win' : 'lose';
    } else {
      this.my_win_outcome = iStarted ? 'lose' : 'win';
    }

    const [alice_for_alice, alice_for_bob] = select_cards_using_bits(
      this.alice_cards,
      this.alice_discards,
    );
    const [bob_for_bob, bob_for_alice] = select_cards_using_bits(
      this.bob_cards,
      this.bob_discards,
    );

    this.alice_final_hand = [...bob_for_alice];
    alice_for_alice.forEach((c) => this.alice_final_hand.push(c));
    this.alice_final_hand.sort(compare_card);

    this.bob_final_hand = [...alice_for_bob];
    bob_for_bob.forEach((c) => this.bob_final_hand.push(c));
    this.bob_final_hand.sort(compare_card);

    this.alice_used_cards = select_cards_using_bits(
      this.alice_final_hand,
      this.alice_selects,
    )[1];
    this.bob_used_cards = select_cards_using_bits(
      this.bob_final_hand,
      this.bob_selects,
    )[1];

    const iAmAlice = !iStarted;
    this.my_cards = iAmAlice ? this.alice_cards : this.bob_cards;
    this.their_cards = iAmAlice ? this.bob_cards : this.alice_cards;
    this.my_final_hand = iAmAlice ? this.alice_final_hand : this.bob_final_hand;
    this.their_final_hand = iAmAlice ? this.bob_final_hand : this.alice_final_hand;
    this.my_used_cards = iAmAlice ? this.alice_used_cards : this.bob_used_cards;
    this.their_used_cards = iAmAlice ? this.bob_used_cards : this.alice_used_cards;
    this.my_hand_value = iAmAlice ? this.alice_hand_value : this.bob_hand_value;
    this.their_hand_value = iAmAlice ? this.bob_hand_value : this.alice_hand_value;
  }
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
  spend(blob: string, spendBundle: unknown, source?: string, fee?: bigint): Promise<string>;
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
