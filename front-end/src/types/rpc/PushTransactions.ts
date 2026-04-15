export interface CoinsetCoin {
  parent_coin_info: string;
  puzzle_hash: string;
  amount: number;
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
  min_secs_since_created?: number;
  min_time?: number;
  min_blocks_since_created?: number;
  min_height?: number;
  max_secs_after_created?: number;
  max_time?: number;
  max_blocks_after_created?: number;
  max_height?: number;
}

export interface TransactionRecord {
  confirmed_at_height: number;
  created_at_time: number;
  to_puzzle_hash: string;
  amount: number;
  fee_amount: number;
  confirmed: boolean;
  sent: number;
  spend_bundle: WalletSpendBundle | null;
  additions: CoinsetCoin[];
  removals: CoinsetCoin[];
  wallet_id: number;
  sent_to: Array<[string, number, string | null]>;
  trade_id: string | null;
  type: number;
  name: string;
  memos: Record<string, string[]>;
  valid_times: ConditionValidTimes;
  to_address: string;
}

export interface PushTransactionsRequest {
  transactions: TransactionRecord[];
  push?: boolean;
  fee?: number;
}

export interface PushTransactionsResponse {
  success: boolean;
}
