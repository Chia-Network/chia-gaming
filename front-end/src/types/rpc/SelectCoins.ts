export interface SelectCoinsRequest {
  walletId: bigint;
  amount: bigint;
  allowUnsynced?: boolean;
}

export interface SelectCoinsCoin {
  parentCoinInfo: string;
  puzzleHash: string;
  amount: bigint;
}

export interface SelectCoinsResponse {
  coins: SelectCoinsCoin[];
  success: boolean;
}
