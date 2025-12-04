import { useState, useEffect, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  WasmStateInit,
  doInternalLoadWasm,
  fetchHex,
  storeInitArgs,
  loadCalpoker,
} from './WasmStateInit';
import {
  GameConnectionState,
  CalpokerOutcome,
  BlockchainInboundAddressResult,
  BlockchainReport,
  OutcomeLogLine,
  handValueToDescription,
  RngId,
} from '../types/ChiaGaming';
import { getSearchParams, empty, getRandomInt, getEvenHexString } from '../util';
import { ChildFrameBlockchainInterface } from './ChildFrameBlockchainInterface';
import { configGameObject, getBlobSingleton, initStarted, setInitStarted } from './blobSingleton';

let blobSingleton: any = null;

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
  const [lastOutcome, setLastOutcome] = useState<CalpokerOutcome | undefined>(
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
      console.log('recognizeOutcome', outcome);
      setLastOutcome(outcome);
      const mySelects = !iStarted ? outcome.alice_selects : outcome.bob_selects;
      const theirSelects = !iStarted ? outcome.bob_selects : outcome.alice_selects;
      const myFinalHand = !iStarted ? outcome.alice_final_hand : outcome.bob_final_hand;
      const opponentFinalHand = !iStarted ? outcome.bob_final_hand : outcome.alice_final_hand;
      const myCards = !iStarted ? outcome.alice_used_cards : outcome.bob_used_cards;
      const myValue = !iStarted
        ? outcome.alice_hand_value
        : outcome.bob_hand_value;
      const theirCards = !iStarted ? outcome.bob_used_cards : outcome.alice_used_cards;
      const theirValue = !iStarted
        ? outcome.bob_hand_value
        : outcome.alice_hand_value;
      const myHandDescription = handValueToDescription(myValue, myCards);
      const opponentHandDescription = handValueToDescription(theirValue, theirCards);
      let newLogObject = {
        topLineOutcome: outcome.my_win_outcome,
        myHandDescription,
        opponentHandDescription,
        myHand: myCards,
        opponentHand: theirCards,
        myStartHand: playerHand,
        opponentStartHand: opponentHand,
        myFinalHand,
        opponentFinalHand,
        mySelects,
        opponentSelects: theirSelects,
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
    setTheirShare: setTheirShare,
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
    const subscription = gameObject.getObservable().subscribe({
      next: (state: any) => setState(state)
    });

    if (initStarted) {
      return () => {
        subscription.unsubscribe();
      };
    } else {
      setInitStarted(true);
    }

    // pass wasmconnection into wasmblobwrapper
    empty().then(async () => {
      let calpokerHex = await loadCalpoker(fetchHex);
      await configGameObject(gameObject, iStarted, wasmStateInit, calpokerHex, blockchain, uniqueId, amount);
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
    lastOutcome,
  };
}
