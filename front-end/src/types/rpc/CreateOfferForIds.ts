import { TradeRecord } from '../TradeRecord';

export interface CreateOfferForIdsRequest {
  offer: { [walletId: string]: bigint };
  driverDict?: any;
  validateOnly?: boolean;
  disableJSONFormatting?: boolean;
  fee?: bigint;
  extraConditions?: Array<{ opcode: bigint; args: any }>;
  includedCoinIds?: string[];
  primaryCoin?: string;
  allowUnsynced?: boolean;
}

export interface CreateOfferForIdsResponse {
  offer: string;
  tradeRecord: TradeRecord;
}
