export type GetHeightInfoRequest = { usePeakHeight?: boolean };

export interface GetHeightInfoResponse {
  height: number;
  isTransactionBlock: boolean | null;
  prevTransactionBlockHeight: number | null;
  latestTransactionBlockHeight: number;
  success: boolean;
}
