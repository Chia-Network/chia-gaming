export interface CancelOfferRequest {
    tradeId: string;
    secure: boolean;
    fee: number;
}

export interface CancelOfferResponse {
    success: true;
}
