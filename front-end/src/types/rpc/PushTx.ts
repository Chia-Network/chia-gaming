export interface PushTxRequest {
  spendBundle: object;
  fee?: number;
}

export interface PushTxResponse {
  status: string;
}
