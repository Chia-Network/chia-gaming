export interface CoinsetCoin {
  parent_coin_info: string;
  puzzle_hash: string;
  amount: bigint;
}

export interface CoinsetCoinSpend {
  coin: CoinsetCoin;
  puzzle_reveal: string;
  solution: string;
}

export interface WalletSpendBundle {
  coin_spends: CoinsetCoinSpend[];
  aggregated_signature: string;
}

export interface ConditionValidTimes {
  min_secs_since_created?: bigint;
  min_time?: bigint;
  min_blocks_since_created?: bigint;
  min_height?: bigint;
  max_secs_after_created?: bigint;
  max_time?: bigint;
  max_blocks_after_created?: bigint;
  max_height?: bigint;
}

export interface TransactionRecord {
  confirmed_at_height: bigint;
  created_at_time: bigint;
  to_puzzle_hash: string;
  amount: bigint;
  fee_amount: bigint;
  confirmed: boolean;
  sent: bigint;
  spend_bundle: WalletSpendBundle | null;
  additions: CoinsetCoin[];
  removals: CoinsetCoin[];
  wallet_id: bigint;
  sent_to: Array<[string, bigint, string | null]>;
  trade_id: string | null;
  type: bigint;
  name: string;
  memos: Record<string, string[]>;
  valid_times: ConditionValidTimes;
  to_address: string;
}

export interface PushTransactionsRequest {
  transactions: TransactionRecord[];
  push?: boolean;
  // The chia wallet re-signs bundles by default (auto_sign_txs=True in its
  // tx_endpoint decorator). Our spend bundles are already signed with
  // game/channel keys the wallet does not own, so we must pass sign=false to
  // avoid a "Pubkey <fingerprint> not found (or path/sum hinted to)" error.
  sign?: boolean;
  fee?: bigint;
  allowUnsynced?: boolean;
}

export interface PushTransactionsResponse {
  success: boolean;
}
