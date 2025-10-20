import { TransactionRecord } from '../TransactionRecord';

export interface GetTransactionRequest {
  transactionId: string;
}

export type GetTransactionResponse = TransactionRecord;
