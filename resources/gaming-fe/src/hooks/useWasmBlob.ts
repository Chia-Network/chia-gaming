import { useState, useEffect, useRef, useCallback } from 'react';
import { WasmConnection, GameCradleConfig, IChiaIdentity, GameConnectionState, ExternalBlockchainInterface, ChiaGame, CalpokerOutcome, InternalBlockchainInterface, BlockchainReport } from '../types/ChiaGaming';
import useGameSocket from './useGameSocket';
import { getSearchParams, spend_bundle_to_clvm, decode_sexp_hex, proper_list, popcount } from '../util';
import { useInterval } from '../useInterval';
import { v4 as uuidv4 } from 'uuid';
import { WasmBlobWrapper } from './WasmBlobWrapper';
import { ChildFrameBlockchainInterface, BlockchainOutboundRequest, blockchainConnector } from './ChildFrameBlockchainInterface';
import { blockchainDataEmitter, fakeBlockchainInfo } from './FakeBlockchainInterface';
import { BLOCKCHAIN_SERVICE_URL, GAME_SERVICE_URL } from '../settings';

let blobSingleton: any = null;

function getBlobSingleton(blockchain: InternalBlockchainInterface, uniqueId: string, amount: number, iStarted: boolean) {
  if (blobSingleton) {
    return blobSingleton;
  }

  const deliverMessage = (msg: string) => {
    blobSingleton?.deliverMessage(msg);
  };
  const peercon = useGameSocket(deliverMessage, () => {
    blobSingleton?.kickSystem(2);
  });

  const doInternalLoadWasm = async () => {

    const fetchUrl = GAME_SERVICE_URL + '/chia_gaming_wasm_bg.wasm';
    return fetch(fetchUrl).then(wasm => wasm.blob()).then(blob => {
      return blob.arrayBuffer();
    });
   };

  async function fetchHex(fetchUrl: string): Promise<string> {
    return fetch(fetchUrl).then(wasm => wasm.text());
  }

  // XXX This should move to the parent frame
  console.log('set up blockchain data emitter');
  blockchainDataEmitter.select({
    selection: 0,
    uniqueId
  });

  // XXX This will move to the parent frame when it exists.
  blockchainConnector.getOutbound().subscribe({
    next: (evt: BlockchainOutboundRequest) => {
      console.log('externalBlockchainInterface processing', evt);
      let initialSpend = evt.initialSpend;
      let transaction = evt.transaction;
      if (initialSpend) {
        return fakeBlockchainInfo.do_initial_spend(
          initialSpend.uniqueId,
          initialSpend.target,
          initialSpend.amount
        ).then((result) => {
          blockchainConnector.getReplyEmitter()({
            responseId: evt.requestId,
            initialSpend: result
          });
        }).catch((e) => {
          blockchainConnector.getReplyEmitter()({ responseId: evt.requestId, error: e.toString() });
        });
      } else if (transaction) {
        fakeBlockchainInfo.spend(
          (blob: string) => transaction.spendObject,
          transaction.blob
        ).then((response) => {
          blockchainConnector.getReplyEmitter()({
            responseId: evt.requestId,
            transaction: response
          });
        }).catch((e) => {
          blockchainConnector.getReplyEmitter()({ responseId: evt.requestId, error: e.toString() });
        });
      } else {
        blockchainConnector.getReplyEmitter()({
          responseId: evt.requestId,
          error: `unknown blockchain request type ${JSON.stringify(evt)}`
        });
      }
    }
  });

  blobSingleton = new WasmBlobWrapper(
    blockchain,
    uniqueId,
    amount,
    iStarted,
    doInternalLoadWasm,
    fetchHex,
    peercon
  );

  return blobSingleton;
}


/*
  const setState = useCallback((state: any) => {
    if (state.name != 'game_state') {
      console.error(state);
      return;
    }
    const keys = Object.keys(state.values);
    keys.forEach((k) => {
      if (settable[k]) {
        console.warn(k, state.values[k]);
        settable[k](state.values[k]);
      }
    });
  }, []);
*/

export function useWasmBlob(uniqueId: string) {
  const [realPublicKey, setRealPublicKey] = useState<string | undefined>(undefined);
  const [gameIdentity, setGameIdentity] = useState<any | undefined>(undefined);
  const [uniqueWalletConnectionId, setUniqueWalletConnectionId] = useState(uuidv4());
  const [gameStartCoin, setGameStartCoin] = useState<string | undefined>(undefined);
  const [gameConnectionState, setGameConnectionState] = useState<GameConnectionState>({ stateIdentifier: "starting", stateDetail: ["before handshake"] });
  const [handshakeDone, setHandshakeDone] = useState<boolean>(false);

  const searchParams = getSearchParams();
  const token = searchParams.token;
  const iStarted = searchParams.iStarted !== 'false';
  const playerNumber = iStarted ? 1 : 2;
  const [playerHand, setPlayerHand] = useState<number[][]>([]);
  const [opponentHand, setOpponentHand] = useState<number[][]>([]);
  const [outcome, setOutcome] = useState<CalpokerOutcome | undefined>(undefined);
  const [finalPlayerHand, setFinalPlayerHand] = useState<string[]>([]);
  const [isPlayerTurn, setMyTurn] = useState<boolean>(false);
  const [gameIds, setGameIds] = useState<string[]>([]);
  const [moveNumber, setMoveNumber] = useState<number>(0);
  const [error, setRealError] = useState<string | undefined>(undefined);
  const [cardSelections, setOurCardSelections] = useState<number>(0);
  const amount = parseInt(searchParams.amount);
  const setError = (e: any) => {
    if (e !== undefined && error === undefined) {
      setRealError(e);
    }
  };

  let setCardSelections = useCallback((mask: number) => {
    gameObject?.setCardSelections(mask);
  }, []);
  let messageSender = useCallback((msg: string) => {
    console.error('send message with no sender defined', msg);
  }, []);
  let stopPlaying = useCallback(() => {
    gameObject?.shutDown();
  }, []);

  const blockchain = new ChildFrameBlockchainInterface();

  const gameObject = uniqueId ?
    getBlobSingleton(
      blockchain,
      uniqueId,
      amount,
      iStarted
    ) :
    null;

  useEffect(() => {
    let subscription = blockchain.getObservable().subscribe({
      next: (e: BlockchainReport) => {
        gameObject?.blockNotification(e.peak, e.block, e.report);
      }
    });

    return () => {
      subscription.unsubscribe();
    }
  });

  const handleMakeMove = useCallback((move: any) => {
    gameObject?.makeMove(move);
  }, []);

  (window as any).loadWasm = useCallback((chia_gaming_init: any, cg: any) => {
    console.log('start loading wasm', gameObject);
    gameObject?.loadWasm(chia_gaming_init, cg);
  }, []);

  const settable: any = {
    'setGameConnectionState': setGameConnectionState,
    'setPlayerHand': setPlayerHand,
    'setOpponentHand': setOpponentHand,
    'setMyTurn': setMyTurn,
    'setMoveNumber': setMoveNumber,
    'setError': setError,
    'setCardSelections': setOurCardSelections,
    'setOutcome': setOutcome
  };

  useEffect(() => {
    if (!gameObject) {
      return;
    }

    let subscription = gameObject.getObservable().subscribe({next: (state: any) => {
      const keys = Object.keys(state);
      keys.forEach((k) => {
        if (settable[k]) {
          console.warn(k, state[k]);
          settable[k](state[k]);
        }
      });
    }});
    return(() => {
      subscription.unsubscribe();
    });
  });

  return {
    error,
    gameIdentity,
    gameConnectionState,
    uniqueWalletConnectionId,
    realPublicKey,
    isPlayerTurn,
    iStarted,
    playerNumber,
    handleMakeMove,
    playerHand,
    opponentHand,
    moveNumber,
    cardSelections,
    setCardSelections,
    stopPlaying,
    outcome
  };
}
