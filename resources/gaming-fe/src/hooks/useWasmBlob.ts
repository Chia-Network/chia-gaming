import { useState, useEffect, useRef, useCallback } from 'react';
import { WasmConnection, GameCradleConfig, IChiaIdentity, GameConnectionState, ExternalBlockchainInterface, ChiaGame, CalpokerOutcome, InternalBlockchainInterface, BlockchainReport } from '../types/ChiaGaming';
import useGameSocket from './useGameSocket';
import { getSearchParams, spend_bundle_to_clvm, decode_sexp_hex, proper_list, popcount } from '../util';
import { useInterval } from '../useInterval';
import { v4 as uuidv4 } from 'uuid';
import { WasmBlobWrapper } from './WasmBlobWrapper';
import { BlockchainOutboundRequest } from './BlockchainConnector';
import { connectSimulatorBlockchain } from './FakeBlockchainInterface';
import { ChildFrameBlockchainInterface } from './ChildFrameBlockchainInterface';
import { blockchainDataEmitter } from './BlockchainInfo';
import { blockchainConnector } from './BlockchainConnector';
import { PARENT_FRAME_BLOCKCHAIN_ID, parentFrameBlockchainInfo } from './ParentFrameBlockchainInfo';
import { BLOCKCHAIN_SERVICE_URL, GAME_SERVICE_URL } from '../settings';

let blobSingleton: any = null;

function getBlobSingleton(blockchain: InternalBlockchainInterface, lobbyUrl: string, uniqueId: string, amount: number, perGameAmount: number, iStarted: boolean) {
  if (blobSingleton) {
    return blobSingleton;
  }

  const deliverMessage = (msg: string) => {
    blobSingleton?.deliverMessage(msg);
  };
  const peercon = useGameSocket(lobbyUrl, deliverMessage, () => {
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

  blobSingleton = new WasmBlobWrapper(
    blockchain,
    uniqueId,
    amount,
    perGameAmount,
    iStarted,
    doInternalLoadWasm,
    fetchHex,
    peercon
  );

  // This lives in the child frame.
  // We'll connect the required signals.
  window.addEventListener('message', (evt: any) => {
    const key = evt.message ? 'message' : 'data';
    let data = evt[key];
    if (data.blockchain_reply) {
      if (evt.origin != window.location.origin) {
        throw new Error(`wrong origin for child event: ${JSON.stringify(evt)}`);
      }
      blockchainConnector.getInbound().next(data.blockchain_reply);
    }

    if (data.blockchain_info) {
      if (evt.origin != window.location.origin) {
        throw new Error(`wrong origin for child event: ${JSON.stringify(evt)}`);
      }
      parentFrameBlockchainInfo.next(data.blockchain_info);
    }
  });

  blockchainConnector.getOutbound().subscribe({
    next: (evt: any) => {
      window.parent.postMessage({
        blockchain_request: evt
      }, window.location.origin);
    }
  });
  blockchainDataEmitter.select({
    selection: PARENT_FRAME_BLOCKCHAIN_ID,
    uniqueId
  });

  return blobSingleton;
}

export function useWasmBlob(lobbyUrl: string, uniqueId: string) {
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
  const [log, setLog] = useState<string[]>([]);
  const [addressData, setAddressData] = useState<any>({});
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
  let perGameAmount = amount / 10;
  try {
    perGameAmount = parseInt(searchParams.perGame);
  } catch (e) {
    // not ok if perGame wasn't empty.
    if (searchParams.perGame) {
      throw e;
    }
  }
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
      lobbyUrl,
      uniqueId,
      amount,
      perGameAmount,
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

  const recognizeOutcome = (outcome: any) => {
    setOutcome(outcome);
    if (outcome) {
      setLog([...log, outcome?.my_win_outcome]);
    }
  };

  const settable: any = {
    'setGameConnectionState': setGameConnectionState,
    'setPlayerHand': setPlayerHand,
    'setOpponentHand': setOpponentHand,
    'setMyTurn': setMyTurn,
    'setMoveNumber': setMoveNumber,
    'setError': setError,
    'setCardSelections': setOurCardSelections,
    'setOutcome': recognizeOutcome,
    'setAddressData': setAddressData
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
    addressData,
    log,
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
