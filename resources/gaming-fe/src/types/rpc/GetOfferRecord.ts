import { TradeRecord } from '../TradeRecord';

export interface GetOfferRecordRequest {
    offerId: string;
}

export interface GetOfferRecordResponse {
    offer: null;
    tradeRecord: TradeRecord;
    success: true;
}
