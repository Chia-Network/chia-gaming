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
  SaveData,
} from '../types/ChiaGaming';
import { getSearchParams, empty, getRandomInt, getEvenHexString } from '../util';
import { ChildFrameBlockchainInterface } from './ChildFrameBlockchainInterface';
import {
  configGameObject,
  getBlobSingleton,
  initStarted,
  setInitStarted,
  deserializeGameObject,
} from './blobSingleton';
import {
  saveGame,
  startNewSession,
} from './save';

let blobSingleton: any = null;

export interface UseWasmBlobResult {
  error: any;
  log: OutcomeLogLine[];
  amount: number;
  addressData: BlockchainInboundAddressResult | undefined;
  ourShare: number | undefined;
  theirShare: number | undefined;
  gameConnectionState: GameConnectionState;
  isPlayerTurn: boolean;
  iStarted: boolean;
  moveNumber: number;
  handleMakeMove: (hex: string) => void;
  playerHand: number[][];
  opponentHand: number[][];
  playerNumber: number;
  cardSelections: number;
  setCardSelections: (s: number) => void;
  outcome: CalpokerOutcome | undefined;
  lastOutcome: CalpokerOutcome | undefined;
  stopPlaying: () => void;
};

export function useWasmBlob(searchParams: any, lobbyUrl: string, uniqueId: string): UseWasmBlobResult {
  const [realPublicKey] = useState<string | undefined>(undefined);
  const [balance, setBalance] = useState<number | undefined>(undefined);
  const [ourShare, setOurShare] = useState<number | undefined>(undefined);
  const [theirShare, setTheirShare] = useState<number | undefined>(undefined);
  const [gameConnectionState, setGameConnectionState] =
    useState<GameConnectionState>({
      stateIdentifier: 'starting',
      stateDetail: ['before handshake'],
    });

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
  const amount = parseInt(searchParams.amount);

  const setSavedGame = (game: any) => {
    let serialized = { game, searchParams, id: game.id, addressData, url: window.location.toString() };
    const saveResult = saveGame(serialized);
    if (saveResult) {
      setError(`${saveResult[0]}: ${saveResult[1].toString()}`);
    }
  };

  const recognizeOutcome = (outcome: CalpokerOutcome | undefined) => {
    setOutcome(outcome);
    if (outcome) {
      const iAmAlice = !iStarted;
      console.log('recognizeOutcome', outcome);
      const mySelects = iAmAlice ? outcome.alice_selects : outcome.bob_selects;
      const theirSelects = iAmAlice ? outcome.bob_selects : outcome.alice_selects;
      const myFinalHand = iAmAlice ? outcome.alice_final_hand : outcome.bob_final_hand;
      const opponentFinalHand = iAmAlice ? outcome.bob_final_hand : outcome.alice_final_hand;
      const myCards = iAmAlice ? outcome.alice_used_cards : outcome.bob_used_cards;
      const myValue = iAmAlice
        ? outcome.alice_hand_value
        : outcome.bob_hand_value;
      const theirCards = iAmAlice ? outcome.bob_used_cards : outcome.alice_used_cards;
      const theirValue = iAmAlice
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
        myPicks: iAmAlice ? outcome.alice_discards : outcome.bob_discards,
        opponentPicks: iAmAlice ? outcome.bob_discards : outcome.alice_discards
      };
      setLog([newLogObject, ...log]);
    }
  };

  const recognizeGameConnectionState = async (cs: GameConnectionState) => {
    if (cs.stateIdentifier === 'shutdown') {
      startNewSession();
    }
    setGameConnectionState(cs);
  }

  const setError = (e: any) => {
    if (e !== undefined && error === undefined) {
      setRealError(e);
    }
  };

  const settable: any = {
    setGameConnectionState: recognizeGameConnectionState,
    setPlayerHand,
    setOpponentHand,
    setMyTurn,
    setMoveNumber,
    setCardSelections: setOurCardSelections,
    setOutcome: recognizeOutcome,
    setAddressData,
    setOurShare,
    setTheirShare,
    setLastOutcome,
    setError,
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

    // Save last so we can observe all ui updates.
    if (state.setSavedGame) {
      setSavedGame(state.setSavedGame);
    }
  }

  let perGameAmount = amount / 10;
  try {
    perGameAmount = parseInt(searchParams.perGame);
  } catch (e) {
    // not ok if perGame wasn't empty.
    if (searchParams.perGame) {
      throw e;
    }
  }
  const blockchain = new ChildFrameBlockchainInterface();

  const { gameObject, hostLog } = getBlobSingleton(
    blockchain,
    searchParams,
    lobbyUrl,
    uniqueId,
    amount,
    perGameAmount,
    iStarted,
    setState,
  );

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
    gameConnectionState,
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
