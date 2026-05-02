export interface SelectCoinsRequest {
  walletId: number;
  amount: number | string;
  allowUnsynced?: boolean;
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
