import { useState, useEffect, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  WasmStateInit,
  doInternalLoadWasm,
  fetchHex,
  storeInitArgs,
  loadCalpoker,
} from './WasmStateInit';
import { GAME_SERVICE_URL } from '../settings';
import {
  GameConnectionState,
  CalpokerOutcome,
  InternalBlockchainInterface,
  BlockchainInboundAddressResult,
  BlockchainReport,
  OutcomeLogLine,
  handValueToDescription,
  RngId,
} from '../types/ChiaGaming';
import { getSearchParams, empty, getRandomInt, getEvenHexString } from '../util';

import { blockchainConnector } from './BlockchainConnector';
import { blockchainDataEmitter } from './BlockchainInfo';
import { ChildFrameBlockchainInterface } from './ChildFrameBlockchainInterface';
import {
  PARENT_FRAME_BLOCKCHAIN_ID,
  parentFrameBlockchainInfo,
} from './ParentFrameBlockchainInfo';
import { WasmBlobWrapper } from './WasmBlobWrapper';
import useGameSocket from './useGameSocket';
import { setupBlockchainConnection } from './useBlockchainConnection';

let blobSingleton: any = null;
let initStarted = false;

function getBlobSingleton(
  blockchain: InternalBlockchainInterface,
  lobbyUrl: string,
  uniqueId: string,
  amount: number,
  perGameAmount: number,
  iStarted: boolean,
) {
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
    return fetch(fetchUrl)
      .then((wasm) => wasm.blob())
      .then((blob) => {
        return blob.arrayBuffer();
      });
  };

  async function fetchHex(fetchUrl: string): Promise<string> {
    return fetch(fetchUrl).then((wasm) => wasm.text());
  }

  blobSingleton = new WasmBlobWrapper(
    blockchain,
    uniqueId,
    amount,
    perGameAmount,
    iStarted,
    doInternalLoadWasm,
    fetchHex,
    peercon,
  );

  setupBlockchainConnection(uniqueId);

  return blobSingleton;
}

export function useWasmBlob(lobbyUrl: string, uniqueId: string) {
  const [realPublicKey] = useState<string | undefined>(undefined);
  const [gameIdentity] = useState<any | undefined>(undefined);
  const [uniqueWalletConnectionId] = useState(uuidv4());
  const [balance, setBalance] = useState<number | undefined>(undefined);
  const [ourShare, setOurShare] = useState<number | undefined>(undefined);
  const [theirShare, setTheirShare] = useState<number | undefined>(undefined);
  const [gameConnectionState, setGameConnectionState] =
    useState<GameConnectionState>({
      stateIdentifier: 'starting',
      stateDetail: ['before handshake'],
    });

  const searchParams = getSearchParams();
  const iStarted = searchParams.iStarted !== 'false';
  const playerNumber = iStarted ? 1 : 2;
  const [log, setLog] = useState<OutcomeLogLine[]>([]);
  const [addressData, setAddressData] =
    useState<BlockchainInboundAddressResult>({
      address: '',
      puzzleHash: '',
    });
  const [playerHand, setPlayerHand] = useState<number[][]>([]);
  const [opponentHand, setOpponentHand] = useState<number[][]>([]);
  const [outcome, setOutcome] = useState<CalpokerOutcome | undefined>(
    undefined,
  );
  const [isPlayerTurn, setMyTurn] = useState<boolean>(false);
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

  const gameObject = uniqueId
    ? getBlobSingleton(
        blockchain,
        lobbyUrl,
        uniqueId,
        amount,
        perGameAmount,
        iStarted,
      )
    : null;

  const setCardSelections = useCallback(
    (mask: number) => {
      gameObject?.setCardSelections(mask);
    },
    [gameObject],
  );

  const stopPlaying = useCallback(() => {
    gameObject?.shutDown();
  }, [gameObject]);

  useEffect(() => {
    const subscription = blockchain.getObservable().subscribe({
      next: (e: BlockchainReport) => {
        gameObject?.blockNotification(e.peak, e.block, e.report);
      },
    });

    return () => {
      subscription.unsubscribe();
    };
  });

  const handleMakeMove = useCallback((move: any) => {
    gameObject?.makeMove(move);
  }, []);

  (window as any).loadWasm = useCallback((chia_gaming_init: any, cg: any) => {
    console.log('start loading wasm', gameObject);
    gameObject?.loadWasm(chia_gaming_init, cg);
  }, []);

  const recognizeOutcome = (outcome: CalpokerOutcome | undefined) => {
    setOutcome(outcome);
    if (outcome) {
      const myCards = !iStarted ? outcome.alice_used_cards : outcome.bob_used_cards;
      const myValue = !iStarted
        ? outcome.alice_hand_value
        : outcome.bob_hand_value;
      const theirCards = !iStarted ? outcome.bob_used_cards : outcome.alice_used_cards;
      const theirValue = !iStarted
        ? outcome.bob_hand_value
        : outcome.alice_hand_value;
      let newLogObject = {
        topLineOutcome: outcome.my_win_outcome,
        myHandDescription: handValueToDescription(myValue, myCards),
        opponentHandDescription: handValueToDescription(theirValue, theirCards),
        myHand: myCards,
        opponentHand: theirCards,
        myStartHand: playerHand,
        opponentStartHand: opponentHand,
        myPicks: iStarted ? outcome.alice_discards : outcome.bob_discards,
        opponentPicks: iStarted ? outcome.bob_discards : outcome.alice_discards
      };
      setLog([newLogObject, ...log]);
    }
  };

  const settable: any = {
    setGameConnectionState: setGameConnectionState,
    setPlayerHand: setPlayerHand,
    setOpponentHand: setOpponentHand,
    setMyTurn: setMyTurn,
    setMoveNumber: setMoveNumber,
    setError: setError,
    setCardSelections: setOurCardSelections,
    setOutcome: recognizeOutcome,
    setAddressData: setAddressData,
    setOurShare: setOurShare,
    setTheirShare: setTheirShare
  };

  function setState(state: any): void {
    if (state.setMyTurn !== undefined) {
      console.log('state.setMyTurn:', state);
    }
    const keys = Object.keys(state);
    keys.forEach((k) => {
      if (settable[k]) {
        // console.warn(k, state[k]);
        settable[k](state[k]);
      }
    });
  }

  useEffect(() => {
    if (initStarted) {
      return;
    } else {
      initStarted = true;
    }

    const subscription = gameObject.getObservable().subscribe({
      next: (state: any) => {
        const keys = Object.keys(state);
        keys.forEach((k) => {
          if (settable[k]) {
            console.warn(k, state[k]);
            settable[k](state[k]);
          }
        });
      }
    });

    // pass wasmconnection into wasmblobwrapper
    empty().then(async () => {
      let wasmConnection = await wasmStateInit.getWasmConnection();
      gameObject.loadWasm(wasmConnection);
      let calpokerHex = await loadCalpoker(fetchHex);
      let seed = getRandomInt(1<<31);
      let seedStr = getEvenHexString(seed);
      let rngId = wasmConnection.create_rng(seedStr);
      let identity = wasmConnection.chia_identity(rngId);
      let address = await blockchain.getAddress();
      let cradle = wasmStateInit.createGame(calpokerHex, rngId, wasmConnection, identity.private_key, iStarted, amount, amount, address.puzzleHash);
      gameObject.setGameCradle(cradle);
      let coin = await wasmStateInit.createStartCoin(blockchain, uniqueId, identity, amount, wasmConnection);
      gameObject.activateSpend(coin);
    });

    return () => {
      subscription.unsubscribe();
    }
  });


  // Called once at an arbitrary time.
  (window as any).loadWasm = useCallback((chia_gaming_init: any, cg: any) => {
    console.log(
      'Wasm init: storing chia_gaming_init=',
      chia_gaming_init,
      'and cg=',
      cg,
    );
    storeInitArgs(chia_gaming_init, cg);
  }, []);

  return {
    error,
    addressData,
    amount,
    ourShare,
    theirShare,
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
    outcome,
  };
}
