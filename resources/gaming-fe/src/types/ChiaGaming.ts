import { Subject, Subscription } from 'rxjs';
import { Program } from 'clvm-lib';

export interface Amount {
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

export interface WasmResult {
  outbound_messages?: string[];
  outbound_transactions?: SpendBundle[];
  finished?: boolean;
  receive_errors?: string[];
  notifications?: WasmNotification[];
  coin_solution_requests?: string[];
  ids?: string[];
}

export type WasmInitFn = (opts: { module: ArrayBuffer }) => void;

export interface CoinsetOrgBlockSpend {
  coin: { parent_coin_info: string; puzzle_hash: string; amount: bigint };
  puzzle_reveal: string;
  solution: string;
}

export interface CoinsetCoin {
  parentCoinInfo: string;
  puzzleHash: string;
  amount: bigint;
}

export interface ProposeGameParams {
  game_type: string;
  timeout: number;
  amount: bigint;
  my_contribution: bigint;
  my_turn: boolean;
  parameters: Program | null;
}

export interface IChiaIdentity {
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

export interface SaveData {
  ourTurn: boolean;
  turnNumber: number;
  unrollPuzzleHash: string;
  gameCradle: unknown;
}

export type StateIdentifier = 'starting' | 'running' | 'clean_shutdown' | 'end';

export interface GameCradleConfig {
  seed: string | undefined;
  game_types: Map<string, string>;
  identity: string | undefined;
  have_potato: boolean;
  my_contribution: Amount;
  their_contribution: Amount;
  channel_timeout: number;
  reward_puzzle_hash: string;
  receive_error: string | undefined;
}

export interface GameInitParams {
  env: WasmConnection;
  rng: RngId;
  chiaIdentity: IChiaIdentity;
  iStarted: boolean;
  myContribution: bigint;
  theirContribution: bigint;
}

export type IChiaIdentityFun = (seed: string) => IChiaIdentity;

export interface GameSessionParams {
  iStarted: boolean;
  amount: bigint;          // mojos, total channel buy-in
  perGameAmount: bigint;   // mojos per hand
  token: string;
  lobbyUrl: string;
}

export interface PeerIdentity {
  token: string;
  iStarted: boolean;
}

export type WasmNotificationTag =
  | 'ChannelCreated' | 'ChannelCoinSpent' | 'UnrollCoinSpent'
  | 'StaleChannelUnroll' | 'ChannelError'
  | 'CleanShutdownStarted' | 'CleanShutdownComplete'
  | 'GoingOnChain' | 'GameOnChain'
  | 'GameProposed' | 'GameProposalAccepted' | 'GameProposalCancelled'
  | 'OpponentMoved' | 'GameMessage'
  | 'OpponentPlayedIllegalMove'
  | 'WeSlashedOpponent' | 'OpponentSlashedUs' | 'OpponentSuccessfullyCheated'
  | 'WeTimedOut' | 'OpponentTimedOut'
  | 'GameCancelled' | 'GameError'
  | 'InsufficientBalance';

export type WasmNotification = {
  [K in WasmNotificationTag]?: Record<string, unknown>;
};

export type WasmEvent =
  | { type: 'notification'; data: WasmNotification }
  | { type: 'error'; error: string }
  | { type: 'finished' }
  | { type: 'address'; data: BlockchainInboundAddressResult };

export interface GameCradleCreateConfig {
  rng_id: number;
  game_types: Record<string, { version: number; hex: string; parser_hex: string }>;
  have_potato: boolean;
  my_contribution: Amount;
  their_contribution: Amount;
  channel_timeout: number;
  unroll_timeout: number;
  reward_puzzle_hash: string;
}

export interface WasmConnection {
  // System
  init: (print: (msg: string) => void) => void;
  create_rng: (seed: string) => number;
  create_game_cradle: (config: GameCradleCreateConfig) => { id: number; puzzle_hash: string };
  create_serialized_game: (serialized: unknown, new_seed: string) => number;
  deposit_file: (name: string, data: string) => void;

  // Blockchain
  opening_coin: (cid: number, coinstring: string) => WasmResult | undefined;
  new_block: (
    cid: number,
    height: number,
    additions: string[],
    removals: string[],
    timed_out: string[],
  ) => WasmResult | undefined;
  convert_coinset_org_block_spend_to_watch_report: (
    parent_coin_info: string,
    puzzle_hash: string,
    amount: string,
    puzzle_reveal: string,
    solution: string,
  ) => WatchReport | undefined;
  convert_spend_to_coinset_org: (spend: string) => unknown;
  convert_coinset_to_coin_string: (
    parent_coin_info: string,
    puzzle_hash: string,
    amount: string,
  ) => string;
  convert_chia_public_key_to_puzzle_hash: (public_key: string) => string;

  // Game
  propose_game: (cid: number, game: Omit<ProposeGameParams, 'parameters'>, parameters: Uint8Array) => WasmResult | undefined;
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
  accept_timeout: (cid: number, id: string) => WasmResult | undefined;
  shut_down: (cid: number) => WasmResult | undefined;
  go_on_chain: (cid: number) => WasmResult | undefined;
  report_puzzle_and_solution: (
    cid: number,
    coin_hex: string,
    puzzle_hex: string | undefined,
    solution_hex: string | undefined,
  ) => WasmResult | undefined;
  deliver_message: (cid: number, inbound_message: string) => WasmResult | undefined;
  cradle_amount: (cid: number) => number;
  cradle_our_share: (cid: number) => number;
  cradle_their_share: (cid: number) => number;
  get_identity: (cid: number) => IChiaIdentity;
  get_game_state_id: (cid: number) => string | undefined;
  serialize_cradle: (cid: number) => unknown;

  // Misc
  sha256bytes: (hex: string) => string;
}

export interface CoinOutput {
  puzzle_hash: string;
  amount: bigint;
}

export interface CreateStartCoinReturn {
  coinString: string;
  blockchainInboundAddressResult: BlockchainInboundAddressResult;
}

export class ChiaGame {
  wasm: WasmConnection;
  waiting_messages: string[];
  cradle: number;

  constructor(
    wasm: WasmConnection,
    cradleId: number,
  ) {
    this.wasm = wasm;
    this.waiting_messages = [];
    this.cradle = cradleId;
  }

  propose_game(game: Omit<ProposeGameParams, 'parameters'>, parameters: Uint8Array): WasmResult | undefined {
    return this.wasm.propose_game(this.cradle, game, parameters);
  }

  accept_proposal(game_id: string): WasmResult | undefined {
    return this.wasm.accept_proposal(this.cradle, game_id);
  }

  accept_proposal_and_move(game_id: string, readable: Uint8Array): WasmResult | undefined {
    return this.wasm.accept_proposal_and_move(this.cradle, game_id, readable);
  }

  cancel_proposal(game_id: string): WasmResult | undefined {
    return this.wasm.cancel_proposal(this.cradle, game_id);
  }

  amount(): number {
    return this.wasm.cradle_amount(this.cradle);
  }

  our_share(): number {
    return this.wasm.cradle_our_share(this.cradle);
  }

  their_share(): number {
    return this.wasm.cradle_their_share(this.cradle);
  }

  get_game_state_id(): string | undefined {
    return this.wasm.get_game_state_id(this.cradle);
  }

  serialize(): unknown {
    return this.wasm.serialize_cradle(this.cradle);
  }

  accept(id: string): WasmResult | undefined {
    return this.wasm.accept_timeout(this.cradle, id);
  }

  shut_down(): WasmResult | undefined {
    return this.wasm.shut_down(this.cradle);
  }

  go_on_chain(): WasmResult | undefined {
    return this.wasm.go_on_chain(this.cradle);
  }

  report_puzzle_and_solution(
    coin_hex: string,
    puzzle_hex: string | undefined,
    solution_hex: string | undefined,
  ): WasmResult | undefined {
    return this.wasm.report_puzzle_and_solution(this.cradle, coin_hex, puzzle_hex, solution_hex);
  }

  make_move(id: string, readable: Uint8Array): WasmResult | undefined {
    return this.wasm.make_move(this.cradle, id, readable);
  }

  make_move_with_entropy_for_testing(id: string, readable: Uint8Array, new_entropy: string): WasmResult | undefined {
    return this.wasm.make_move_with_entropy_for_testing(this.cradle, id, readable, new_entropy);
  }

  cheat(game_id: string, mover_share: number): WasmResult | undefined {
    return this.wasm.cheat(this.cradle, game_id, String(mover_share));
  }

  deliver_message(msg: string): WasmResult | undefined {
    return this.wasm.deliver_message(this.cradle, msg);
  }

  opening_coin(coin_string: string): WasmResult | undefined {
    return this.wasm.opening_coin(this.cradle, coin_string);
  }

  block_data(block_number: number, block_data: WatchReport): WasmResult | undefined {
    const arrays = [block_data.created_watched, block_data.deleted_watched, block_data.timed_out];
    for (const arr of arrays) {
      if (!Array.isArray(arr)) {
        console.error('[wasm] block_data: non-array field in WatchReport:', block_data);
        return undefined;
      }
      for (const s of arr) {
        if (typeof s !== 'string' || s.length % 2 !== 0) {
          console.error('[wasm] block_data: bad hex element:', JSON.stringify(s),
            'type:', typeof s, 'in report:', JSON.stringify(block_data));
          return undefined;
        }
      }
    }
    return this.wasm.new_block(
      this.cradle,
      block_number,
      block_data.created_watched,
      block_data.deleted_watched,
      block_data.timed_out,
    );
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
  timed_out: string[];
}

export interface BlockchainConnection {
  getToken: () => string;

  // Blockchain
  get_peak: () => Promise<number>;
  get_block_data: (block: number) => Promise<WatchReport | null>;
  wait_block: () => Promise<number>;
  get_puzzle_and_solution: (coin: string) => Promise<string[] | null>;
  spend: (clvm_hex_spend_blob: string) => Promise<(number | null)[]>;
  create_spendable: (
    target_ph: string,
    amount: bigint,
  ) => Promise<string | null>;
}

export class ExternalBlockchainInterface {
  baseUrl: string;
  token: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.token = '';
  }

  getOrRequestToken(uniqueId: string): Promise<string> {
    if (this.token) {
      return new Promise((resolve, _reject) => resolve(this.token));
    }

    return fetch(`${this.baseUrl}/register?name=${uniqueId}`, {
      body: '',
      method: 'POST',
    })
      .then((f) => f.json())
      .then((token) => {
        this.token = token;
        return token;
      });
  }

  getToken(): string {
    return this.token;
  }

  getPeak(): Promise<number> {
    return fetch(`${this.baseUrl}/get_peak`, {
      body: '',
      method: 'POST',
    }).then((f) => f.json());
  }

  getBlockData(block: number): Promise<WatchReport | null> {
    return fetch(`${this.baseUrl}/get_block_data?block=${block}`, {
      body: '',
      method: 'POST',
    }).then((f) => f.json());
  }

  waitBlock(): Promise<number> {
    return fetch(`${this.baseUrl}/wait_block`, {
      body: '',
      method: 'POST',
    }).then((f) => f.json());
  }

  getPuzzleAndSolution(coin: string): Promise<string[] | null> {
    return fetch(`${this.baseUrl}/get_puzzle_and_solution?coin=${coin}`, {
      body: '',
      method: 'POST',
    }).then((f) => f.json());
  }

  spend(spend_data_clvm_hex: string): Promise<(number | null)[]> {
    return fetch(`${this.baseUrl}/spend?blob=${spend_data_clvm_hex}`, {
      body: '',
      method: 'POST',
    }).then((f) => f.json());
  }

  createSpendable(target_ph: string, amt: bigint): Promise<string | null> {
    return fetch(
      `${this.baseUrl}/create_spendable?who=${this.token}&target=${target_ph}&amount=${amt}`,
      {
        body: '',
        method: 'POST',
      },
    ).then((f) => f.json());
  }

  getBalance(): Promise<number> {
    return fetch(
      `${this.baseUrl}/get_balance?user=${this.token}`,
      {
        body: '',
        method: 'POST'
      },
    ).then((f) => f.json());
  }
}

function select_cards_using_bits<T>(card: T[], mask: number): T[][] {
  const result0: T[] = [];
  const result1: T[] = [];
  card.forEach((c, i) => {
    if (mask & (1 << i)) {
      result1.push(c);
    } else {
      result0.push(c);
    }
  });
  return [result0, result1];
}

function compare_card(a: number, b: number): number {
  const aRankSuit = cardIdToRankSuit(a);
  const bRankSuit = cardIdToRankSuit(b);
  const rankdiff = aRankSuit.rank - bRankSuit.rank;
  if (rankdiff === 0) {
    return aRankSuit.suit - bRankSuit.suit;
  }
  return rankdiff;
}

export interface PeerConnectionResult {
  sendMessage: (msgno: number, input: string) => void;
  hostLog: (msg: string) => void;
}

export class CalpokerOutcome {
  alice_discards: number;
  bob_discards: number;

  alice_selects: number;
  bob_selects: number;

  alice_hand_value: number[];
  bob_hand_value: number[];

  win_direction: number;
  my_win_outcome: 'win' | 'lose' | 'tie';

  alice_cards: number[];
  bob_cards: number[];

  alice_final_hand: number[];
  bob_final_hand: number[];

  alice_used_cards: number[];
  bob_used_cards: number[];

  my_cards: number[];
  their_cards: number[];
  my_final_hand: number[];
  their_final_hand: number[];
  my_used_cards: number[];
  their_used_cards: number[];
  my_hand_value: number[];
  their_hand_value: number[];

  constructor(
    iStarted: boolean,
    myDiscards: number,
    alice_cards: number[],
    bob_cards: number[],
    readableBytes: number[],
  ) {
    const program = Program.deserialize(Uint8Array.from(readableBytes));
    const result_list = program.toList();
    this.alice_cards = alice_cards;
    this.bob_cards = bob_cards;

    this.alice_selects = result_list[1].toInt();
    this.bob_selects = result_list[2].toInt();
    this.alice_hand_value = result_list[3].toList().map(v => v.toInt());
    this.bob_hand_value = result_list[4].toList().map(v => v.toInt());
    let raw_win_direction = result_list[5].toInt();
    if (iStarted) {
      raw_win_direction *= -1;
      this.alice_discards = result_list[0].toInt();
      this.bob_discards = myDiscards;
    } else {
      this.alice_discards = myDiscards;
      this.bob_discards = result_list[0].toInt();
    }

    this.win_direction = raw_win_direction;
    const alice_win = this.win_direction < 0;

    if (this.win_direction === 0) {
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

export interface SelectionMessage {
  selection: number;
  uniqueId: string;
}

// An object which presents a single observable downstream of a number of other
// observables.  It does not pass on events until one of the upstream slots is
// selected.
export class ToggleEmitter<T> {
  upstream: Subject<T>[];
  subscriptions: Subscription[];
  downstream: Subject<T>;
  upstreamSelect: (s: SelectionMessage) => void;
  upstreamSelection: Subject<SelectionMessage>;
  selection: number;

  addUpstream(upstream: Subject<T>): number {
    const i = this.subscriptions.length;
    this.subscriptions.push(
      upstream.subscribe({
        next: (elt: T) => {
          if (this.selection === i) {
            this.downstream.next(elt);
          }
        },
      }),
    );
    return i;
  }

  select(s: SelectionMessage) {
    this.selection = s.selection;
    this.upstreamSelect(s);
    this.upstreamSelect = (_s: SelectionMessage) => void 0;
  }

  getObservable() {
    return this.downstream;
  }

  getSelectionObservable() {
    return this.upstreamSelection;
  }

  close() {
    this.subscriptions.forEach((s) => s.unsubscribe());
  }

  constructor() {
    this.upstream = [];
    this.upstreamSelect = (_s) => void 0;
    this.selection = -1;
    this.subscriptions = [];
    this.downstream = new Subject<T>();
    this.subscriptions = [];
    this.upstreamSelection = new Subject<SelectionMessage>();
    this.upstreamSelect = (s: SelectionMessage) =>
      this.upstreamSelection.next(s);
  }
}

export interface BlockchainReport {
  peak: number;
  block: CoinsetOrgBlockSpend[] | undefined;
  report: WatchReport | undefined;
}

export interface DoInitialSpendResult {
  fromPuzzleHash: string;
  coin: string | { parentCoinInfo: string; puzzleHash: string; amount: number | bigint };
}

export interface BlockchainInboundAddressResult {
  address: string;
  puzzleHash: string;
}

export interface InternalBlockchainInterface {
  do_initial_spend(
    uniqueId: string,
    target: string,
    amt: bigint,
  ): Promise<DoInitialSpendResult>;
  spend(convert: (blob: string) => unknown, spend: string): Promise<string>;
  getAddress(): Promise<BlockchainInboundAddressResult>;
  getBalance(): Promise<number>;
  getPuzzleAndSolution(coin: string): Promise<string[] | null>;
}

export interface OutcomeHandType {
  name: string;
  values: number[];
}

export interface OutcomeLogLine {
  topLineOutcome: 'win' | 'lose' | 'tie';
  myStartHand: number[];
  opponentStartHand: number[];
  myFinalHand: number[];
  opponentFinalHand: number[];
  myPicks: number;
  opponentPicks: number;
  mySelects: number;
  opponentSelects: number;
  myHandDescription: OutcomeHandType;
  opponentHandDescription: OutcomeHandType;
  myHand: number[];
  opponentHand: number[];
}

// Must match features/californiaPoker/constants/constants.ts:SUITS
export const suitNames = ['Q', '♠', '♥', '♦', '♣'];

export function cardIdToRankSuit(cardId: number): { rank: number; suit: number } {
  const rank = Math.floor(cardId / 4) + 2;
  const suit = (cardId % 4) + 1;
  return { rank, suit };
}

function aget<T>(handValue: T[], choice: number, def: T): T {
  if (choice > handValue.length || choice < 0) {
    return def;
  }

  return handValue[choice];
}

function rget<T>(array: T[], start: number, end: number, def: T): T[] {
  const result = [];
  for (let i = start; i < end; i++) {
    result.push(aget(array, i, def));
  }

  return result;
}

export function handValueToDescription(
  handValue: number[],
  myCards: number[],
): OutcomeHandType {
  const handType = rget(handValue, 0, 3, 0);

  // Hand encoding from onehandcalc.clinc:
  //   straight flush: (5 high_card)
  //   4 of a kind:    (4 1 quad_rank kicker)
  //   full house:     (3 2 set_rank pair_rank)
  //   flush:          (3 1 3 high_card k1 k2 k3 k4)
  //   straight:       (3 1 2 high_card)
  //   set:            (3 1 1 set_rank k1 k2)
  //   two pair:       (2 2 1 high_pair low_pair kicker)
  //   pair:           (2 1 1 1 pair_rank k1 k2 k3)
  //   high card:      (1 1 1 1 1 high k1 k2 k3 k4)

  switch (handType.toString()) {
    case '3,1,3':
      return {
        name: 'Flush',
        values: rget(handValue, 3, 8, 0),
      };

    case '3,1,2':
      return {
        name: 'Straight',
        values: [aget(handValue, 3, 0)],
      };

    case '3,1,1':
      return {
        name: 'Three of a kind',
        values: rget(handValue, 3, 6, 0),
      };

    case '2,2,1':
      return {
        name: 'Two Pair',
        values: rget(handValue, 3, 6, 0),
      };

    case '2,1,1':
      return {
        name: 'Pair',
        values: rget(handValue, 4, 8, 0),
      };
  }

  handType.pop();

  switch (handType.toString()) {
    case '4,1':
      return {
        name: 'Four of a kind',
        values: rget(handValue, 2, 4, 0),
      };

    case '3,2':
      return {
        name: 'Full house',
        values: rget(handValue, 2, 4, 0),
      };
  }

  if (handType[0] == 5) {
    return {
      name: 'Straight flush',
      values: [aget(handValue, 1, 0)],
    };
  }

  return {
    name: 'High card',
    values: rget(handValue, 5, 10, 0),
  };
}
