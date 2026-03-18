export interface SelectCoinsRequest {
  walletId: number;
  amount: number;
}

export interface SelectCoinsCoin {
  parentCoinInfo: string;
  puzzleHash: string;
  amount: number;
}

export interface SelectCoinsResponse {
  coins: SelectCoinsCoin[];
  success: boolean;
}
