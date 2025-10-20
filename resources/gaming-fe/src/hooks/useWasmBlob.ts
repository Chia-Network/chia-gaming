import { useState, useEffect, useCallback } from "react";
import {
  WasmBlobParams,
  GameConnectionState,
  CalpokerOutcome,
  BlockchainReport,
  RngId,
} from "../types/ChiaGaming";
import { getGameSocket } from "../services/GameSocket";
import { getSearchParams } from "../util";
import { v4 as uuidv4 } from "uuid";
import { ChildFrameBlockchainInterface } from "./ChildFrameBlockchainInterface";
import { blockchainDataEmitter } from "./BlockchainInfo";
import { blockchainConnector } from "./BlockchainConnector";
import {
  PARENT_FRAME_BLOCKCHAIN_ID,
  parentFrameBlockchainInfo,
} from "./ParentFrameBlockchainInfo";
import {
  WasmStateInit,
  doInternalLoadWasm,
  fetchHex,
  storeInitArgs,
} from "./WasmStateInit";
import { WasmBlobWrapper, getNewChiaGameCradle } from "./WasmBlobWrapper";
import {
  WasmCommand,
  wasmCommandChannel,
  DeliverMessage,
  SocketEnabled,
  WasmMove,
  SetCardSelections,
  Shutdown,
} from "../types/GameController";

let onceDammit = false;

export function useWasmBlob(lobbyUrl: string, uniqueId: string) {
  const [realPublicKey, setRealPublicKey] = useState<string | undefined>(
    undefined,
  );
  const [gameIdentity, setGameIdentity] = useState<any | undefined>(undefined);
  const [gameStartCoin, setGameStartCoin] = useState<string | undefined>(
    undefined,
  );
  const [gameConnectionState, setGameConnectionState] =
    useState<GameConnectionState>({
      stateIdentifier: "starting",
      stateDetail: ["before handshake"],
    });
  const searchParams = getSearchParams();
  const token = searchParams.token;
  const iStarted = searchParams.iStarted !== "false";
  const playerNumber = iStarted ? 1 : 2;
  const [playerHand, setPlayerHand] = useState<number[][]>([]);
  const [opponentHand, setOpponentHand] = useState<number[][]>([]);
  const [outcome, setOutcome] = useState<CalpokerOutcome | undefined>(
    undefined,
  );
  const [finalPlayerHand, setFinalPlayerHand] = useState<string[]>([]);
  const [isPlayerTurn, setMyTurn] = useState<boolean>(false);
  const [gameIds, setGameIds] = useState<string[]>([]);
  const [moveNumber, setMoveNumber] = useState<number>(0);
  const [error, setRealError] = useState<string | undefined>(undefined);
  const [cardSelections, setOurCardSelections] = useState<number>(0);
  const [wasmStateInit, setWasmStateInit] = useState<WasmStateInit>(
    new WasmStateInit(doInternalLoadWasm, fetchHex),
  );

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

  const blockchain = new ChildFrameBlockchainInterface();

  /*
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

*/
  const settable: any = {
    setGameConnectionState: setGameConnectionState,
    setPlayerHand: setPlayerHand,
    setOpponentHand: setOpponentHand,
    setMyTurn: setMyTurn,
    setMoveNumber: setMoveNumber,
    setError: setError,
    setCardSelections: setOurCardSelections,
    setOutcome: setOutcome,
  };

  function setState(state: any): void {
    if (state.setMyTurn !== undefined) {
      console.log("state.setMyTurn:", state);
    }
    const keys = Object.keys(state);
    keys.forEach((k) => {
      if (settable[k]) {
        // console.warn(k, state[k]);
        settable[k](state[k]);
      }
    });
  }

  //
  const loadCalpoker: () => Promise<any> = () => {
    const calpokerFactory = fetchHex(
      "clsp/games/calpoker-v1/calpoker_include_calpoker_factory.hex",
    );
    setState({
      setGameConnectionState: {
        stateIdentifier: "starting",
        stateDetail: ["loaded calpoker"],
      },
    });
    return calpokerFactory;
  };

  useEffect(() => {
    if (!onceDammit) {
      console.log(
        "Wasm init in ",
        window.parent,
        ": checking gotWasmStateInit",
      );
      onceDammit = true;
    } else {
      return;
    }
    console.log("Wasm init starting: ");
    window.addEventListener("message", (evt: any) => {
      const key = evt.message ? "message" : "data";
      let data = evt[key];
      if (data.blockchain_reply) {
        if (evt.origin != window.location.origin) {
          throw new Error(
            `wrong origin for child event: ${JSON.stringify(evt)}`,
          );
        }
        blockchainConnector.getInbound().next(data.blockchain_reply);
      }

      if (data.blockchain_info) {
        if (evt.origin != window.location.origin) {
          throw new Error(
            `wrong origin for child event: ${JSON.stringify(evt)}`,
          );
        }
        parentFrameBlockchainInfo.next(data.blockchain_info);
      }
      // console.log('window.addEventListener for ', evt, 'done');
    });

    blockchainConnector.getOutbound().subscribe({
      next: (evt: any) => {
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
    console.log("Subscribed to blockchain connection.");
    loadCalpoker()
      .then((calpokerHex) => {
        console.log("Calpoker ChiaLisp loaded");
        return wasmStateInit.getWasmConnection().then((wasmConnection) => {
          console.log("Wasm connection active");
          return {
            calpokerHex,
            wasmConnection,
          };
        });
      })
      .then(async ({ calpokerHex, wasmConnection }) => {
        const env = {
          game_types: {
            calpoker: {
              version: 1,
              hex: calpokerHex,
            },
          },
          timeout: 100,
          unroll_timeout: 100,
        };
        console.log("Configuring known game types: ", env);
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
          myContribution: parseInt(searchParams.amount),
          theirContribution: parseInt(searchParams.amount),
        };
        let cradle = getNewChiaGameCradle(wasmConnection, gameInitParams);
        console.log("Chia Gaming Cradle created. Session ID:", hexString);
        console.log("I am ", iStarted ? "Alice" : "Bob");

        const peerconn = getGameSocket(
          lobbyUrl,
          (msg: string) => {
            liveGame.deliverMessage(msg);
          },
          () => {
            liveGame.kickSystem(1);
          },
        );

        let wasmParams: WasmBlobParams = {
          blockchain: blockchain,
          peerconn: peerconn,
          cradle: cradle,
          uniqueId: uniqueId,
          iStarted: iStarted,
          fetchHex: fetchHex,
        };

        const liveGame = new WasmBlobWrapper(
          wasmParams,
          wasmConnection,
          perGameAmount,
        );
        console.log("WasmBlobWrapper game object created.");

        wasmCommandChannel.subscribe({
          next: (wasmCommand: WasmCommand) => {
            const msg: WasmCommand = wasmCommand;
            console.log("Sending wasm command:", Object.keys(msg));
            if ("wasmMove" in wasmCommand) {
              liveGame.makeMove(msg);
            } else if ("setCardSelections" in wasmCommand) {
              liveGame.setCardSelections(
                (msg as SetCardSelections).setCardSelections,
              );
            } else if ("shutDown" in wasmCommand) {
              liveGame.shutDown("Normal Shutdown");
            } else if ("deliverMessage" in wasmCommand) {
              liveGame.deliverMessage(wasmCommand.deliverMessage);
            }
          },
        });
        let blockSubscription = blockchain.getObservable().subscribe({
          next: (e: BlockchainReport) => {
            // console.log('Received Chia block ', e.peak);
            liveGame.blockNotification(e.peak, e.block, e.report);
          },
        });

        console.log("About to subscribe to liveGame.getObservable");
        let stateSubscription = liveGame.getObservable().subscribe({
          next: (state: any) => {
            if (Object.keys(state).length > 0) {
              console.log("About to call setState(", state, ")");
            }
            setState(state);
            if (state.shutdown) {
              console.log("Chia Gaming shutting down.");
              stateSubscription.unsubscribe();
              blockSubscription.unsubscribe();
            }
          },
        });

        console.log("Wasm Initialization Complete.");
        const startCoin = await liveGame.createStartCoin();
        return { liveGame, startCoin };
      })
      .then(({ liveGame, startCoin }) => {
        console.log("Initial coin creation complete. Got: ", startCoin);
        if (startCoin === undefined) {
          throw "Failed to create initial game coin";
        }
        setGameStartCoin(startCoin);
        liveGame.setStartCoin(startCoin);
        console.log(
          "about to start game - IS hanshake_done ???",
          liveGame.getHandshakeDone(),
        );
        //liveGame.internalStartGame();
        //liveGame.pushEvent({startGame: true});
        liveGame.startGame();
        console.log("Chia Gaming infrastructure Initialization Complete.");
      });
    console.log(
      "Chia Gaming infrastructure Initialization threaded and ready to be configured.",
    );
  }, []); // useEffect end

  // Called once at an arbitrary time.
  (window as any).loadWasm = useCallback((chia_gaming_init: any, cg: any) => {
    console.log(
      "Wasm init: storing chia_gaming_init=",
      chia_gaming_init,
      "and cg=",
      cg,
    );
    storeInitArgs(chia_gaming_init, cg);
  }, []);

  const handleMakeMove = (move: string) => {
    console.log("in useWasmBlob::useEffect::handleMakeMove");
    wasmCommandChannel.next({ wasmMove: move });
  };

  const setCardSelections = (selected: number) => {
    wasmCommandChannel.next({ setCardSelections: selected });
  };
  const stopPlaying = () => {
    wasmCommandChannel.next({ shutdown: true });
  };

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
    outcome,
  };
}
