export interface CoinRecord {
  coin: {
    parentCoinInfo: string;
    puzzleHash: string;
    amount: bigint;
  };
  confirmedBlockIndex: bigint;
  spentBlockIndex: bigint;
  spent: boolean;
  coinbase: boolean;
  timestamp: bigint;
}
