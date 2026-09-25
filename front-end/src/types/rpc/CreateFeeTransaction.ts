import { TransactionRecord } from './PushTransactions';

export interface CreateFeeTransactionRequest {
  fee: bigint;
  // Bind the fee spend to the protocol coin so it cannot be farmed on its own.
  extraConditions?: Array<{ opcode: bigint; args: any }>;
  coins?: unknown[];
  // Leave push unset (defaults to false in the wallet tx_endpoint) so the
  // wallet only constructs and signs the fee spend; we aggregate it with the
  // protocol bundle and broadcast the combined transaction ourselves.
  push?: boolean;
  allowUnsynced?: boolean;
}

export interface CreateFeeTransactionResponse {
  transactions: TransactionRecord[];
  unsignedTransactions: unknown[];
}
