import {
  blockchainConnector,
  BlockchainInboundReply,
  BlockchainOutboundRequest,
} from './BlockchainConnector';
import { blockchainDataEmitter } from './BlockchainInfo';
import {
  PARENT_FRAME_BLOCKCHAIN_ID,
  parentFrameBlockchainInfo,
} from './ParentFrameBlockchainInfo';
import { BlockchainReport } from '../types/ChiaGaming';

interface ChildFrameMessage {
  blockchain_reply?: BlockchainInboundReply;
  blockchain_info?: BlockchainReport;
}

// This lives in the child frame.
export function setupBlockchainConnection(uniqueId: string) {
  const windowListener = (evt: MessageEvent<ChildFrameMessage>) => {
    const data = evt.data;
    if (data.blockchain_reply) {
      if (evt.origin !== window.location.origin) {
        if (data.blockchain_reply.getBalance !== undefined) {
          fetch('/lobby/tracking').then(res => res.json()).then((tracking: string[]) => {
            const matchingTracked = tracking.filter((t: string) => {
              const u = new URL(t);
              return u.origin == evt.origin;
            });
            if (matchingTracked.length !== 0) {
              blockchainConnector.getInbound().next(data.blockchain_reply!);
            }
          }).catch(e => console.error('[blockchain] failed to fetch /lobby/tracking:', e));

          return;
        }

        throw new Error(`wrong origin for child event: ${JSON.stringify(evt.data)}`);
      }
      blockchainConnector.getInbound().next(data.blockchain_reply);
    }

    if (data.blockchain_info) {
      if (evt.origin != window.location.origin) {
        throw new Error(`wrong origin for child event: ${JSON.stringify(evt.data)}`);
      }
      parentFrameBlockchainInfo.next(data.blockchain_info);
    }
  };

  window.addEventListener('message', windowListener);

  const connectorSubscription = blockchainConnector.getOutbound().subscribe({
    next: (evt: BlockchainOutboundRequest) => {
      window.parent.postMessage(
        {
          blockchain_request: evt,
        },
        window.location.origin,
      );
    },
  });
  blockchainDataEmitter.select({
    selection: PARENT_FRAME_BLOCKCHAIN_ID,
    uniqueId,
  });

  return () => {
    window.removeEventListener('message', windowListener);
    connectorSubscription.unsubscribe();
  };
}
