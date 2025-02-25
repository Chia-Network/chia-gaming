export interface CheckOfferValidityRequest {
    offerData: string;
}

export interface CheckOfferValidityResponse {
    id: string;
    valid: boolean;
}
