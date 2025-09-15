import { Subject, filter, take } from 'rxjs';
import { DoInitialSpendResult } from '../types/ChiaGaming';
import { fakeBlockchainInfo, blockchainDataEmitter } from './FakeBlockchainInterface';

export interface BlockchainOutboundInitialSpendRequest {
  uniqueId: string;
  target: string;
  amount: number;
}

export interface BlockchainOutboundTransactionRequest {
  blob: string;
  spendObject: any;
}

export interface BlockchainOutboundRequest {
  requestId: number;
  initialSpend?: BlockchainOutboundInitialSpendRequest;
  transaction?: BlockchainOutboundTransactionRequest;
}

export interface BlockchainInboundReply {
  responseId: number;
  initialSpend?: DoInitialSpendResult;
  transaction?: string;
  error?: string;
}

class BlockchainRequestConnector {
  outbound: Subject<BlockchainOutboundRequest>;
  inbound: Subject<BlockchainInboundReply>;

  constructor() {
    this.outbound = new Subject<BlockchainOutboundRequest>();
    this.inbound = new Subject<BlockchainInboundReply>();
  }

  getOutbound() { return this.outbound; }
  getInbound() { return this.inbound; }

  requestEmitter(r: BlockchainOutboundRequest) { this.outbound.next(r); }
  replyEmitter(r: BlockchainInboundReply) { this.inbound.next(r); }
}

let requestNumber = 1;
export const blockchainConnector = new BlockchainRequestConnector();

function performTransaction(
  checkReply: (reply: any) => any,
  requestId: number,
  request: any
): Promise<any> {
  return new Promise((resolve, reject) => {
    let thisRequestChannel = blockchainConnector.getInbound().pipe(
      filter((e: BlockchainInboundReply) => e.responseId === requestId),
      take(1)
    );
    let subscription = thisRequestChannel.subscribe({
      next: (e: BlockchainInboundReply) => {
        if (e.error) {
          console.error('returning error in transaction', e);
          reject(e.error);
          return;
        }

        const replyObject = checkReply(e);
        if (replyObject === undefined || replyObject === null) {
          console.error('no reply in transaction', e);
          reject(`no reply data in reply for request ${JSON.stringify(e)}`);
          return;
        }

        resolve(replyObject);
      }
    });

    blockchainConnector.requestEmitter(request);
  });
}

export class ChildFrameBlockchainInterface {
  do_initial_spend(uniqueId: string, target: string, amount: number): Promise<DoInitialSpendResult> {
    let requestId = requestNumber++;
    let request = {
      requestId,
      initialSpend: { uniqueId, target, amount }
    };

    return performTransaction(
      (e: any) => e.initialSpend,
      requestId,
      request
    );
}

  spend(cvt: (blob: string) => any, spend: string): Promise<string> {
    let requestId = requestNumber++;
    let request = {
      requestId,
      transaction: {
        blob: spend,
        spendObject: cvt(spend)
      }
    };

    return performTransaction(
      (e: any) => e.transaction,
      requestId,
      request
    );
  }

  getObservable() {
    return blockchainDataEmitter.getObservable();
  }
}

export function connectSimulatorBlockchain() {
  blockchainConnector.getOutbound().subscribe({
    next: (evt: BlockchainOutboundRequest) => {
      let initialSpend = evt.initialSpend;
      let transaction = evt.transaction;
      if (initialSpend) {
        return fakeBlockchainInfo.do_initial_spend(
          initialSpend.uniqueId,
          initialSpend.target,
          initialSpend.amount
        ).then((result: any) => {
          blockchainConnector.replyEmitter({
            responseId: evt.requestId,
            initialSpend: result
          });
        }).catch((e: any) => {
          blockchainConnector.replyEmitter({ responseId: evt.requestId, error: e.toString() });
        });
      } else if (transaction) {
        fakeBlockchainInfo.spend(
          (blob: string) => transaction.spendObject,
          transaction.blob
        ).then((response: any) => {
          blockchainConnector.replyEmitter({
            responseId: evt.requestId,
            transaction: response
          });
        }).catch((e: any) => {
          blockchainConnector.replyEmitter({ responseId: evt.requestId, error: e.toString() });
        });
      } else {
        console.error(`unknown blockchain request type ${JSON.stringify(evt)}`);
        blockchainConnector.replyEmitter({
          responseId: evt.requestId,
          error: `unknown blockchain request type ${JSON.stringify(evt)}`
        });
      }
    }
  });
}
