import { Subject } from 'rxjs';

import {
  DoInitialSpendResult,
  BlockchainInboundAddressResult,
} from '../types/ChiaGaming';

export interface BlockchainOutboundInitialSpendRequest {
  uniqueId: string;
  target: string;
  amount: bigint;
}

export interface BlockchainOutboundTransactionRequest {
  blob: string;
  spendObject: unknown;
}

export type BlockchainOutboundAddressRequest = boolean;

export type BlockchainOutboundBalanceRequest = boolean;

export interface BlockchainOutboundRequest {
  requestId: number;
  initialSpend?: BlockchainOutboundInitialSpendRequest;
  transaction?: BlockchainOutboundTransactionRequest;
  getAddress?: BlockchainOutboundAddressRequest;
  getBalance?: BlockchainOutboundBalanceRequest;
  getPuzzleAndSolution?: { coin: string };
}

export interface BlockchainInboundReply {
  responseId: number;
  initialSpend?: DoInitialSpendResult;
  transaction?: string;
  getAddress?: BlockchainInboundAddressResult;
  getBalance?: number;
  getPuzzleAndSolution?: string[] | null;
  error?: string;
}

function describeRequest(r: BlockchainOutboundRequest): string {
  if (r.initialSpend) return 'initialSpend';
  if (r.transaction) return 'transaction';
  if (r.getAddress) return 'getAddress';
  if (r.getBalance) return 'getBalance';
  if (r.getPuzzleAndSolution) return 'getPuzzleAndSolution';
  return 'unknown';
}

function describeReply(r: BlockchainInboundReply): string {
  if (r.error) return `error: ${r.error}`;
  if (r.initialSpend) return 'initialSpend';
  if (r.transaction) return 'transaction';
  if (r.getAddress) return `getAddress`;
  if (r.getBalance !== undefined) return `getBalance=${r.getBalance}`;
  if (r.getPuzzleAndSolution !== undefined) return 'getPuzzleAndSolution';
  return 'unknown';
}

class BlockchainRequestConnector {
  outbound: Subject<BlockchainOutboundRequest>;
  inbound: Subject<BlockchainInboundReply>;

  constructor() {
    this.outbound = new Subject<BlockchainOutboundRequest>();
    this.inbound = new Subject<BlockchainInboundReply>();
  }

  getOutbound() {
    return this.outbound;
  }
  getInbound() {
    return this.inbound;
  }

  requestEmitter(r: BlockchainOutboundRequest) {
    console.log(`[BC] >>> req #${r.requestId} ${describeRequest(r)}`);
    this.outbound.next(r);
  }
  replyEmitter(r: BlockchainInboundReply) {
    console.log(`[BC] <<< reply #${r.responseId} ${describeReply(r)}`);
    this.inbound.next(r);
  }
}

export const blockchainConnector = new BlockchainRequestConnector();
