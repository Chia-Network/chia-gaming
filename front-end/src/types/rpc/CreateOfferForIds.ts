import { TradeRecord } from '../TradeRecord';

export interface CreateOfferForIdsRequest {
  // Wallet RPC transport expects offer deltas as string values.
  offer: { [walletId: string]: number | string };
  driverDict?: any;
  validateOnly?: boolean;
  disableJSONFormatting?: boolean;
  fee?: number;
  extraConditions?: Array<{ opcode: number; args: any }>;
  coinIds?: string[];
}

export interface CreateOfferForIdsResponse {
  offer: string;
  tradeRecord: TradeRecord;
}
