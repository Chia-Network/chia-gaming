export interface CoinRecord {
  coin: {
    parentCoinInfo: string;
    puzzleHash: string;
    amount: number;
  };
  confirmedBlockIndex: number;
  spentBlockIndex: number;
  spent: boolean;
  coinbase: boolean;
  timestamp: number;
}
