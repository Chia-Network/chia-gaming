import { useState, useEffect, useRef, useCallback } from 'react';
import { WasmConnection, GameCradleConfig, IChiaIdentity, GameConnectionState, ExternalBlockchainInterface, ChiaGame, CalpokerOutcome } from '../types/ChiaGaming';
import useGameSocket from './useGameSocket';
import { getSearchParams, spend_bundle_to_clvm, decode_sexp_hex, proper_list, popcount } from '../util';
import { useInterval } from '../useInterval';
import { v4 as uuidv4 } from 'uuid';
import { WasmBlobWrapper } from './WasmBlobWrapper';

let blobSingleton: any = null;

function getBlobSingleton(stateChanger: (state: any) => void, blockchain: ExternalBlockchainInterface, walletToken: string, uniqueId: string, amount: number, iStarted: boolean) {
  if (blobSingleton) {
    return blobSingleton;
  }

  blobSingleton = new WasmBlobWrapper(
    stateChanger,
    blockchain,
    walletToken,
    uniqueId,
    amount,
    iStarted
  );
  return blobSingleton;
}

export function useWasmBlob() {
  const BLOCKCHAIN_SERVICE_URL = process.env.REACT_APP_BLOCKCHAIN_SERVICE_URL || 'http://localhost:5800';

  const [realPublicKey, setRealPublicKey] = useState<string | undefined>(undefined);
  const [gameIdentity, setGameIdentity] = useState<any | undefined>(undefined);
  const [uniqueWalletConnectionId, setUniqueWalletConnectionId] = useState(uuidv4());
  const [gameStartCoin, setGameStartCoin] = useState<string | undefined>(undefined);
  const [gameConnectionState, setGameConnectionState] = useState<GameConnectionState>({ stateIdentifier: "starting", stateDetail: ["before handshake"] });
  const [handshakeDone, setHandshakeDone] = useState<boolean>(false);

  const searchParams = getSearchParams();
  const token = searchParams.token;
  const uniqueId = searchParams.uniqueId;
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

  let setCardSelections = useCallback((mask: number) => {
    gameObject?.setCardSelections(mask);
  }, []);
  let messageSender = useCallback((msg: string) => {
    console.error('send message with no sender defined', msg);
  }, []);
  let stopPlaying = useCallback(() => {
    gameObject?.shutDown();
  }, []);

  const stateChanger = useCallback((state: any) => {
    window.postMessage({ name: 'game_state', values: state });
  }, []);

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

  const walletObject = new ExternalBlockchainInterface(
    BLOCKCHAIN_SERVICE_URL,
    searchParams.walletToken
  );

  const gameObject = uniqueId ?
    getBlobSingleton(
      stateChanger,
      walletObject,
      searchParams.walletToken,
      uniqueId,
      amount,
      iStarted
    ) :
    null;

  const handleMakeMove = useCallback((move: any) => {
    gameObject?.makeMove(move);
  }, []);

  useInterval(() => {
    walletObject.waitBlock().then(new_block_number => {
      gameObject?.waitBlock(new_block_number);
    });
  }, 5000);
  (window as any).loadWasm = useCallback((chia_gaming_init: any, cg: any) => {
    console.log('start loading wasm', gameObject);
    gameObject?.loadWasm(chia_gaming_init, cg);
  }, []);

  return {
    error,
    setState,
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
