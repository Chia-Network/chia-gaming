export type GetHeightInfoRequest = { usePeakHeight?: boolean };

export interface GetHeightInfoResponse {
  height: bigint;
  isTransactionBlock: boolean | null;
  prevTransactionBlockHeight: bigint | null;
  latestTransactionBlockHeight: bigint;
  success: boolean;
}
