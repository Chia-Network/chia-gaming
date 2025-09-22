import { useState, useEffect, useRef, useCallback } from 'react';
import { WasmBlobParams, WasmConnection, GameCradleConfig, IChiaIdentity, GameConnectionState, ExternalBlockchainInterface, ChiaGame, CalpokerOutcome, InternalBlockchainInterface, BlockchainReport } from '../types/ChiaGaming';
import useGameSocket from './useGameSocket';
import { getSearchParams, spend_bundle_to_clvm, decode_sexp_hex, proper_list, popcount } from '../util';
import { useInterval } from '../useInterval';
import { v4 as uuidv4 } from 'uuid';
import { BlockchainOutboundRequest } from './BlockchainConnector';
import { connectSimulatorBlockchain } from './FakeBlockchainInterface';
import { ChildFrameBlockchainInterface } from './ChildFrameBlockchainInterface';
import { blockchainDataEmitter } from './BlockchainInfo';
import { blockchainConnector } from './BlockchainConnector';
import { PARENT_FRAME_BLOCKCHAIN_ID, parentFrameBlockchainInfo } from './ParentFrameBlockchainInfo';
import { WasmStateInit, doInternalLoadWasm, fetchHex, storeInitArgs, waitForReadyToInit } from './WasmStateInit';
import { WasmBlobWrapper, getNewChiaGameCradle } from './WasmBlobWrapper';

// TODO: remove singleton-ness. Rename to "theBlob"
let blobSingleton: any = null;

// TODO: remove singleton-ness
async function getBlobSingleton(blockchain: InternalBlockchainInterface, uniqueId: string, amount: number, iStarted: boolean) {
  if (blobSingleton) {
    return blobSingleton;
  }

  const deliverMessage = (msg: string) => {
    blobSingleton?.deliverMessage(msg);
  };


  // let blobSingleton = new WasmBlobWrapper(
  //   blockchain,
  //   uniqueId,
  //   amount,
  //   iStarted,
  //   wasmConnection,
  //   fetchHex,
  //   peercon,
  //   identity
  // );

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
} // getBlobSingleton

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
  const [wasmStateInit, setWasmStateInit] = useState<WasmStateInit>(new WasmStateInit(doInternalLoadWasm, fetchHex));
  const [gotWasmStateInit, setGotWasmStateInit] = useState<boolean>(false);

  const amount = parseInt(searchParams.amount);
  const setError = (e: any) => {
    if (e !== undefined && error === undefined) {
      setRealError(e);
    }
  };

  let liveGame: undefined | WasmBlobWrapper = undefined;

  if (!gotWasmStateInit) {
    setGotWasmStateInit(true);
  }

  let setCardSelections = useCallback((mask: number) => {
    liveGame?.setCardSelections(mask);
  }, []);
  let messageSender = useCallback((msg: string) => {
    console.error('send message with no sender defined', msg);
  }, []);
  let stopPlaying = useCallback(() => {
    liveGame?.shutDown();
  }, []);

  const blockchain = new ChildFrameBlockchainInterface();

  // const gameObject = uniqueId ?
  //   getBlobSingleton(
  //     blockchain,
  //     uniqueId,
  //     amount,
  //     iStarted
  //   ) :
  //   null;

  const peerconn = useGameSocket(deliverMessage, () => {
    blobSingleton?.kickSystem(1);
  });
  useEffect(() => {
    wasmStateInit.getWasmConnection().then((wasmConnection) => {
      let cradle = getNewChiaGameCradle();
      let wasmParams : WasmBlobParams = {
        blockchain: blockchain,
        peerconn: peerconn,
        cradle: cradle,
        uniqueId: uniqueId,
        iStarted: iStarted,
        fetchHex: fetchHex,
      };

      // TODO: Move all 'liveGame' code here.

      // Make calls from here into wasm into Signals
      // e.g. liveGame?.blockNotification(e.peak, e.block, e.report);
      // call these when the signals are fired.
    });
  });

  useEffect(() => {
    let subscription = blockchain.getObservable().subscribe({
      next: (e: BlockchainReport) => {
        liveGame?.blockNotification(e.peak, e.block, e.report);
      }
    });

    return () => {
      subscription.unsubscribe();
    }
  });

  const handleMakeMove = useCallback((move: any) => {
    liveGame?.makeMove(move);
  }, []);

  // .then(() => {});

  // Called once at an arbitrary time.
  (window as any).loadWasm = useCallback((chia_gaming_init: any, cg: any) => {
    storeInitArgs(chia_gaming_init, cg);
    readyToInit.next(true);
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

  // useEffect(() => {
  //   if (!gameObject) {
  //     return;
  //   }

  //   let subscription = gameObject.getObservable().subscribe({next: (state: any) => {
  //     const keys = Object.keys(state);
  //     keys.forEach((k) => {
  //       if (settable[k]) {
  //         console.warn(k, state[k]);
  //         settable[k](state[k]);
  //       }
  //     });
  //   }});
  //   return(() => {
  //     subscription.unsubscribe();
  //   });
  // });

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

/*
          console.log('Wasm Initialization starts.');
          // env: any, identity: IChiaIdentity, iStarted: boolean, myContribution:number, theirContribution: number
          let rngSeed = "alicebobalicebobalicebobalicebob";
          let rng_id = this.createRng(rngSeed);
          if (!rng_id) { throw("Nah."); }
          let gcParams: ChiaGameParams = {
              rng: rng_id, //rng_id.getId(),
              //game_types: env.game_types,
              identity: identity,
              iStarted: iStarted,
              myContribution: myContribution,
              theirContribution: theirContribution,
              channel_timeout: env.timeout,
              unroll_timeout: env.unroll_timeout,
              reward_puzzle_hash: identity.puzzle_hash,
          };
          liveGame = wasmStateInit.start(gcParams);
          console.log('Wasm Initialization Complete.');

*/

/*
    waitForReadyToInit.subscribe({
      next(_ok_to_start) {
        if (gotWasmStateInit)

        wasmStateInit.internalLoadWasm()
      },
      error(err) {
          console.error('Wasm Initialization error: ' + err);
      },
      complete() {
          console.log('Wasm Initialization Channel closed.');
      },
    });
    //   () => {
    //   //gameStateInit.getNewWasmBlobWrapper().then(() => {
    //     //get a wasm
    //     //gameStateInit.getNewWasmBlobWrapper({})
    //     gameObject = gameStateInit.start().then((v) =>

    //     //});
    //   //console.log('start loading wasm', gameObject);
    //   //gameObject?.loadWasm(chia_gaming_init, cg);
    //   })
    // });

*/