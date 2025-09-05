import { Observable } from 'rxjs';
import { BlockchainReport, DoInitialSpendResult } from '../types/ChiaGaming';
import { FakeBlockchainInterface, fakeBlockchainInfo, blockchainDataEmitter } from './FakeBlockchainInterface';
import { BLOCKCHAIN_SERVICE_URL } from '../settings';

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
  outbound: Observable<BlockchainOutboundRequest>;
  inbound: Observable<BlockchainInboundReply>;
  requestEmitter: (outbound: BlockchainOutboundRequest) => void;
  replyEmitter: (inbound: BlockchainInboundReply) => void;

  constructor() {
    this.requestEmitter = (o: BlockchainOutboundRequest) => {
      throw "Bad outbound emitter";
    };
    this.replyEmitter = (i: BlockchainInboundReply) => {
      throw "Bad inbound emitter";
    };
    this.outbound = new Observable<BlockchainOutboundRequest>((emitter) => {
      this.requestEmitter = (o: BlockchainOutboundRequest) => emitter.next(o);
    });
    this.inbound = new Observable<BlockchainInboundReply>((emitter) => {
      this.replyEmitter = (i: BlockchainInboundReply) => emitter.next(i);
    });
  }

  getOutbound() { return this.outbound; }
  getInbound() { return this.inbound; }

  getRequestEmitter() { return this.requestEmitter; }
  getReplyEmitter() { return this.replyEmitter; }
}

let requestNumber = 1;
export const blockchainConnector = new BlockchainRequestConnector();

function performTransaction(
  checkReply: (reply: any) => any,
  requestId: number,
  request: any
): Promise<any> {
  return new Promise((resolve, reject) => {
    let subscription = blockchainConnector.getInbound().subscribe({
      next: (e: BlockchainInboundReply) => {
        if (e.responseId !== requestId) {
          console.log('got reply to other request', e);
          return;
        }

        console.log('child frame rpc reply', e);
        subscription.unsubscribe();

        if (e.error) {
          console.error('returning error in transaction', e);
          reject(e.error);
          return;
        }

        const replyObject = checkReply(e);
        if (!replyObject) {
          console.error('no reply in transaction', request);
          reject(`no reply data in reply for request ${JSON.stringify(request)}`);
          return;
        }

        resolve(replyObject);
      }
    });
    console.log('rpc emit request', request);
    blockchainConnector.getRequestEmitter()(request);
  }).then((r: any) => {
    blockchainConnector.getReplyEmitter()(r);
    return r;
  });
}

export class ChildFrameBlockchainInterface {
  do_initial_spend(uniqueId: string, target: string, amount: number): Promise<DoInitialSpendResult> {
    console.log('ChildFrameBlockchainInterface::do_initial_spend', uniqueId, target, amount);
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
