export interface SelectCoinsRequest {
  walletId: number;
  amount: number;
}

export interface SelectCoinsCoin {
  parentCoinInfo: string;
  puzzleHash: string;
  amount: number;
}

export type SelectCoinsResponse = SelectCoinsCoin[];
