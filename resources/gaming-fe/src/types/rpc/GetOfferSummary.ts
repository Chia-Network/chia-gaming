import { TradeSummary } from '../TradeSummary';

export interface GetOfferSummaryRequest {
    offerData: string;
}

export interface GetOfferSummaryResponse {
    id: string;
    summary: TradeSummary;
    success: true;
}
