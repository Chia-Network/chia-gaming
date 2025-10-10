export interface VerifySignatureRequest {
  message: string;
  pubkey: string;
  signature: string;
  address?: string;
  signingMode?: string;
}

export interface VerifySignatureResponse {
  isValid: true;
  success: true;
}
