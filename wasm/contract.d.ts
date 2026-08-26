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
  name?: string;
  spends: CoinSpend[];
}

export interface IChiaIdentity {
  private_key: string;
  synthetic_private_key: string;
  public_key: string;
  synthetic_public_key: string;
  puzzle: string;
  puzzle_hash: string;
}

export interface NeedCoinSpendRequest {
  amount: string;
  conditions: Array<{ opcode: bigint | number; args: string[] }>;
  coin_id?: string;
  max_height?: bigint | number;
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

export type ChannelSemanticPhase =
  | 'submitting_channel_spend'
  | 'unrolling'
  | 'finding_state'
  | 'preempting'
  | 'finishing_waiting_timeout'
  | 'finishing_spending'
  | 'resolving';

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
  state_number?: bigint | null;
  unrolling_state_number?: bigint | null;
  preempting_state_number?: bigint | null;
}

export type GameStatusState =
  | 'my-turn'
  | 'their-turn'
  | 'on-chain-my-turn'
  | 'on-chain-their-turn'
  | 'replaying'
  | 'playing-move'
  | 'illegal-move-detected'
  | 'finishing-waiting-timeout'
  | 'finishing-spending'
  | 'ended-cancelled'
  | 'ended-error';

export interface GameStatusOtherParams {
  readable?: unknown;
  mover_share?: unknown;
  illegal_move_detected?: boolean;
  moved_by_us?: boolean;
  game_finished?: boolean;
  forfeited?: boolean;
  submitting_timeout_claim?: boolean;
}

export interface GameStatusPayload {
  id: bigint;
  status: GameStatusState;
  my_reward: unknown | null;
  coin_id: unknown | null;
  reason: string | null;
  other_params: GameStatusOtherParams | null;
}

export type SettlementOutcome =
  | 'accept_settlement'
  | 'settled_cleanly'
  | 'opponent_timed_out'
  | 'forfeited_skipped_reveal'
  | 'lost'
  | 'forfeited_we_accepted'
  | 'we_accepted'
  | 'attempt_to_move_failed'
  | 'timed_out_waiting_for_our_move'
  | 'slashed_opponent'
  | 'opponent_slashed_us'
  | 'opponent_cheated';

export interface GameSettledPayload {
  id: bigint;
  outcome: SettlementOutcome;
  our_share: unknown;
  coin_id: unknown | null;
}

export type ProposalParameterValue =
  | null
  | boolean
  | bigint
  | string
  | Uint8Array
  | ProposalParameterValue[];

export interface ProposalMadePayload {
  id: bigint;
  group_ids: bigint[];
  player_a_contribution: unknown;
  player_b_contribution: unknown;
  sender_is_player_a: unknown;
  timeout: unknown;
  game_type: unknown;
  parameters: ProposalParameterValue;
}

export interface AcceptedGameMember {
  id: bigint;
  amount: unknown;
  our_turn: boolean;
}

export interface ProposalAcceptedGroupPayload {
  members: AcceptedGameMember[];
}

export type CancelReason =
  | 'SupersededByIncoming'
  | 'PeerProposalPending'
  | 'GameActive'
  | 'CancelledByPeer'
  | 'CancelledByUs'
  | 'ChannelError'
  | 'WentOnChain'
  | 'CleanShutdown';

export interface ProposalCancelledPayload {
  id: bigint;
  reason: CancelReason;
}

export interface InsufficientBalancePayload {
  id: bigint;
  our_balance_short: boolean;
  their_balance_short: boolean;
}

export interface ActionFailedPayload {
  id?: bigint;
  action?: 'make_move' | 'accept_settlement' | 'cheat';
  reason: string;
}

export interface MoveRejectedPayload {
  id: bigint;
  tag: string;
  message: string;
}

export interface LocalActionAppliedPayload {
  id: bigint;
  action: 'make_move' | 'accept_settlement' | 'cheat';
}

export interface WasmNotificationMap {
  ChannelStatus: ChannelStatusPayload;
  GameStatus: GameStatusPayload;
  GameSettled: GameSettledPayload;
  ProposalMade: ProposalMadePayload;
  ProposalAcceptedGroup: ProposalAcceptedGroupPayload;
  ProposalCancelled: ProposalCancelledPayload;
  InsufficientBalance: InsufficientBalancePayload;
  MoveRejected: MoveRejectedPayload;
  ActionFailed: ActionFailedPayload;
  LocalActionApplied: LocalActionAppliedPayload;
}

export type WasmNotification = {
  [K in keyof WasmNotificationMap]: { [P in K]: WasmNotificationMap[P] } & {
    [P in Exclude<keyof WasmNotificationMap, K>]?: never;
  };
}[keyof WasmNotificationMap];

export type GameSessionEvent =
  | { OutboundMessage: Uint8Array }
  | { Notification: WasmNotification }
  | { Log: string }
  | { CoinSolutionRequest: string }
  | { ReceiveError: string }
  | { NeedCoinSpend: NeedCoinSpendRequest }
  | { NeedLauncherCoin: true };

export interface WatchedCoinEntry {
  coin_name: string;
  coin_string: string;
}

export type WasmDisposition =
  | { kind: 'active' }
  | { kind: 'await-outbound-terminal'; command: { id: string; message: Uint8Array } }
  | { kind: 'terminal' };

export interface WasmResult {
  events: GameSessionEvent[];
  watchCoins: WatchedCoinEntry[];
  unwatchCoins: WatchedCoinEntry[];
  actionSucceeded: boolean;
  disposition: WasmDisposition;
  ids?: string[];
}

export interface GameSessionConfig {
  rng_id: number;
  have_potato: boolean;
  my_contribution: Amount;
  their_contribution: Amount;
  channel_timeout: number;
  unroll_timeout: number;
  reward_puzzle_hash: string;
  genesis_challenge: string;
}

export interface GameSessionCreateResult {
  id: number;
  puzzle_hash: string;
}
