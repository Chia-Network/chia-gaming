import { TradeRecord } from '../TradeRecord';

export interface CreateOfferForIdsRequest {
  offer: { [walletId: string]: number };
  driverDict?: any;
  validateOnly?: boolean;
  disableJSONFormatting?: boolean;
  fee?: number;
  extraConditions?: Array<{ opcode: number; args: string[] }>;
  coinIds?: string[];
}

export interface CreateOfferForIdsResponse {
  offer: string;
  tradeRecord: TradeRecord;
}
