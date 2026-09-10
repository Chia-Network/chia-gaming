import { TransactionRecord } from './PushTransactions';

export interface SendTransactionRequest {
  walletId: bigint;
  amount: bigint;
  address: string;
  fee?: bigint;
  memos?: string[];
  // TransactionEndpointRequest fields, honored by the wallet's tx_endpoint.
  push?: boolean;
  sign?: boolean;
  // Parsed by conditions_from_json_dicts; each entry is { opcode, args } where
  // args matches the driver's streamable field names (e.g. { coin_id } for
  // ASSERT_CONCURRENT_SPEND).
  extraConditions?: Array<{ opcode: bigint; args: Record<string, unknown> }>;
  allowUnsynced?: boolean;
}

export interface SendTransactionResponse {
  transactions: TransactionRecord[];
  transaction: TransactionRecord;
  transaction_id: string;
  success?: boolean;
}
