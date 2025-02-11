export interface SignMessageByAddressRequest {
    message: string;
    address: string;
}

export interface SignMessageByAddressResponse {
    pubkey: string;
    signature: string;
    signingMode: string;
    success: true;
}
