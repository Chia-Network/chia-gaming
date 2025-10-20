import { filter, take } from 'rxjs';

import {
  DoInitialSpendResult,
  BlockchainInboundAddressResult,
} from '../types/ChiaGaming';

import {
  blockchainConnector,
  BlockchainInboundReply,
} from './BlockchainConnector';
import { blockchainDataEmitter } from './BlockchainInfo';

let requestNumber = 1;

function performTransaction(
  checkReply: (reply: any) => any,
  requestId: number,
  request: any,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const thisRequestChannel = blockchainConnector.getInbound().pipe(
      filter((e: BlockchainInboundReply) => e.responseId === requestId),
      take(1),
    );
    thisRequestChannel.subscribe({
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
      },
    });

    blockchainConnector.requestEmitter(request);
  });
}

export class ChildFrameBlockchainInterface {
  do_initial_spend(
    uniqueId: string,
    target: string,
    amount: number,
  ): Promise<DoInitialSpendResult> {
    const requestId = requestNumber++;
    const request = {
      requestId,
      initialSpend: { uniqueId, target, amount },
    };

    return performTransaction((e: any) => e.initialSpend, requestId, request);
  }

  spend(cvt: (blob: string) => any, spend: string): Promise<string> {
    const requestId = requestNumber++;
    const request = {
      requestId,
      transaction: {
        blob: spend,
        spendObject: cvt(spend),
      },
    };

    return performTransaction((e: any) => e.transaction, requestId, request);
  }

  getAddress(): Promise<BlockchainInboundAddressResult> {
    let requestId = requestNumber++;
    let request = {
      requestId,
      getAddress: { walletId: 1 },
    };

    return performTransaction((e: any) => e.getAddress, requestId, request);
  }

  getObservable() {
    return blockchainDataEmitter.getObservable();
  }
}
