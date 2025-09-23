import { useState, useEffect, useRef, useCallback } from 'react';
import { WasmBlobParams, WasmConnection, GameCradleConfig, IChiaIdentity, GameConnectionState, ExternalBlockchainInterface, ChiaGame, CalpokerOutcome, InternalBlockchainInterface, BlockchainReport, RngId } from '../types/ChiaGaming';
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
import { Subject } from 'rxjs';

export interface DeliverMessage {
  deliverMessage: string;
}
export interface SocketEnabled {
  socketEnabled: boolean;
}
export interface WasmMove {
  wasmMove: string;
}
export interface SetCardSelections {
  setCardSelections: number;
}
export interface Shutdown {
  shutdown: boolean;
}
export type WasmCommand = DeliverMessage | SocketEnabled | WasmMove | SetCardSelections | Shutdown;

export function useWasmBlob(uniqueId: string) {
  const [realPublicKey, setRealPublicKey] = useState<string | undefined>(undefined);
  const [gameIdentity, setGameIdentity] = useState<any | undefined>(undefined);
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

  const blockchain = new ChildFrameBlockchainInterface();

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

  function setState(state: any): void {
    const keys = Object.keys(state);
    keys.forEach((k) => {
      if (settable[k]) {
        console.warn(k, state[k]);
        settable[k](state[k]);
      }
    });
  }

  const wasmCommandChannel = new Subject<WasmCommand>();

  const peerconn = useGameSocket(
    (msg) => { wasmCommandChannel.next({ msg }); },
    () => { wasmCommandChannel.next({ socketEnabled: true }); }
  );
  //SocketEnabled
  const loadCalpoker: () => Promise<any> = () => {
    const calpokerFactory = fetchHex(
      "clsp/games/calpoker-v1/calpoker_include_calpoker_factory.hex"
    );
    // continue here xxx
    // use a signal to push this data outward from wasm
    // TODO: resolve 'undefined' on liveGame
    // outbound signal
    setState({
      'setGameConnectionState': {
        stateIdentifier: "starting",
        stateDetail: ["loaded calpoker"]
      }
    });
    return calpokerFactory;
  }

  useEffect(() => {
    if (!gotWasmStateInit) {
      setGotWasmStateInit(true);
    } else {
      return;
    }

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

    loadCalpoker().then((calpokerHex) => {
      return wasmStateInit.getWasmConnection().then((wasmConnection) => {
        return {
          calpokerHex, wasmConnection
        };
      });
    }).then(({ calpokerHex, wasmConnection }) => {
      const env = {
        game_types: {
          "calpoker": {
            version: 1,
            hex: calpokerHex
          }
        },
        timeout: 100,
        unroll_timeout: 100
      };

      const uuid = uuidv4();
      const hexString = uuid.replaceAll("-", "");
      const rngId = wasmConnection.create_rng(hexString);

      const gameInitParams = {
        wasmConnection,
        env,
        rng: new RngId(rngId),
        chiaIdentity: wasmConnection.chia_identity(rngId),
        iStarted, // iStarted, aka have_potato
        // TODO: IEEE float ('number') is a slightly smaller range than MAX_NUM_MOJOS
        // TODO: CalPoker has both players contribute equal amounts. Change this code before Krunk
        myContribution: searchParams.amount,
        theirContribution: searchParams.amount,
      }
      let cradle = getNewChiaGameCradle(wasmConnection, gameInitParams);

      let wasmParams: WasmBlobParams = {
        blockchain: blockchain,
        peerconn: peerconn,
        cradle: cradle,
        uniqueId: uniqueId,
        iStarted: iStarted,
        fetchHex: fetchHex,
      };

      const liveGame = new WasmBlobWrapper(wasmParams, wasmConnection)
      wasmCommandChannel.subscribe({next: (wasmCommand: WasmCommand) => {
        const msg: WasmCommand = wasmCommand;
        console.log('Sending wasm command:', Object.keys(msg));
        // makeMoveImmediate, internalSetCardSelections, internalShutdown, internalTakeBlock
        // wasmCommandChannel.pushEvent(msg);
        if (wasmCommand.wasmMove) {
          //wasmCommandChannel.next({move});
          liveGame.makeMoveImmediate(msg);
        } else if (wasmCommand.setCardSelections !== undefined) {
          liveGame.setCardSelections(msg.setCardSelections);
        } else if (wasmCommand.shutDown) {
          liveGame.internalShutdown();
        }
      }});
      let blockSubscription = blockchain.getObservable().subscribe({
        next: (e: BlockchainReport) => {
          liveGame.blockNotification(e.peak, e.block, e.report);
        }
      });

      let stateSubscription = liveGame.getObservable().subscribe({
        next: (state: any) => {
          setState(state);
          if (state.shutdown) {
            stateSubscription.unsubscribe();
            blockSubscription.unsubscribe();
          }
        }
      });



      //   return(() => {
      //     subscription.unsubscribe();
      //   });
      // });

      // TODO: Check the (now 2) kick states
      // blobSingleton?.kickSystem(1);

      // ----------------

      // Make calls from here into wasm into Signals
      // e.g. liveGame?.blockNotification(e.peak, e.block, e.report);
      // call these when the signals are fired.

    });
}); // useEffect end




  // .then(() => {});

  // Called once at an arbitrary time.
  (window as any).loadWasm = useCallback((chia_gaming_init: any, cg: any) => {
    storeInitArgs(chia_gaming_init, cg);
  }, []);

  const handleMakeMove = (move: string) => {
    wasmCommandChannel.next({wasmMove: move});
  }

  const setCardSelections = (selected: number) => {
    wasmCommandChannel.next({setCardSelections: selected});
  }
  const stopPlaying = () => {
    wasmCommandChannel.next({shutdown: true});
  }

  return {
    error,
    gameIdentity,
    gameConnectionState,
    realPublicKey,
    isPlayerTurn,
    iStarted,
    playerNumber,

    playerHand,
    opponentHand,
    moveNumber,
    cardSelections,

    // push wasmCommand
    handleMakeMove,
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