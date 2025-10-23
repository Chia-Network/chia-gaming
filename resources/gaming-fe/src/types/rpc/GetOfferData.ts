import { TradeRecord } from '../TradeRecord';

export interface GetOfferDataRequest {
  offerId: string;
}

export interface GetOfferDataResponse {
  offer: string;
  tradeRecord: TradeRecord;
  success: true;
}
