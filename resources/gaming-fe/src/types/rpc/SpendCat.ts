import { TransactionRecord } from '../TransactionRecord';

export interface SpendCatRequest {
    walletId: number;
    address: string;
    amount: number;
    fee: number;
    memos?: string[];
    waitForConfirmation?: boolean;
}

export interface SpendCatResponse {
    transaction: TransactionRecord;
    transactionId: string;
    success: true;
}
