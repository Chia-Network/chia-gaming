import { TradeRecord } from '../TradeRecord';

export interface TakeOfferRequest {
    offer: string;
    fee: number;
}

export interface TakeOfferResponse {
    tradeRecord: TradeRecord;
    success: true;
}
