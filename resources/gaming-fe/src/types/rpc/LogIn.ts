export interface LogInRequest {
    fingerprint: number;
}

export interface LogInResponse {
    fingerprint: number;
    success: true;
}
