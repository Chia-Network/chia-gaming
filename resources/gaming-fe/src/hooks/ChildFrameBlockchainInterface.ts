import { filter, take } from 'rxjs';

import {
  DoInitialSpendResult,
  BlockchainInboundAddressResult,
} from '../types/ChiaGaming';

import {
  blockchainConnector,
  BlockchainInboundReply,
  BlockchainOutboundRequest,
} from './BlockchainConnector';
import { blockchainDataEmitter } from './BlockchainInfo';

let requestNumber = 1;

function performTransaction<T>(
  checkReply: (reply: BlockchainInboundReply) => T | undefined | null,
  requestId: number,
  request: BlockchainOutboundRequest,
): Promise<T> {
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
    amount: bigint,
  ): Promise<DoInitialSpendResult> {
    const requestId = requestNumber++;
    const request = {
      requestId,
      initialSpend: { uniqueId, target, amount },
    };

    return performTransaction((e) => e.initialSpend, requestId, request);
  }

  spend(cvt: (blob: string) => unknown, spend: string): Promise<string> {
    const requestId = requestNumber++;
    const request = {
      requestId,
      transaction: {
        blob: spend,
        spendObject: cvt(spend),
      },
    };

    return performTransaction((e) => e.transaction, requestId, request);
  }

  getAddress(): Promise<BlockchainInboundAddressResult> {
    const requestId = requestNumber++;
    const request = {
      requestId,
      getAddress: true as const,
    };

    return performTransaction((e) => e.getAddress, requestId, request);
  }

  getBalance(): Promise<number> {
    const requestId = requestNumber++;
    const request = {
      requestId,
      getBalance: true as const,
    };

    return performTransaction(
      (e) => e.getBalance,
      requestId,
      request,
    );
  }

  getPuzzleAndSolution(coin: string): Promise<string[] | null> {
    const requestId = requestNumber++;
    const request = { requestId, getPuzzleAndSolution: { coin } };
    return performTransaction((e) => e.getPuzzleAndSolution, requestId, request);
  }

  getObservable() {
    return blockchainDataEmitter.getObservable();
  }
}
