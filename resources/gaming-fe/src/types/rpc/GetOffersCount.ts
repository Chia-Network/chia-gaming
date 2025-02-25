export interface GetOffersCountRequest {}

export interface GetOffersCountResponse {
    myOffersCount: number;
    takenOffersCount: number;
    total: number;
    success: true;
}
