import { useState, useEffect, useRef, useCallback } from "react";
import { getSearchParams } from '../util';
import io, { Socket } from "socket.io-client";
import { PeerConnectionResult } from '../types/ChiaGaming';

export type GameState = "idle" | "searching" | "playing";

interface StartGameData {
  playerHand: string[];
  opponentHand: string[];
  playerNumber: number;
  opponentWager: string;
  wagerAmount: string;
  currentTurn: number;
}

interface ActionData {
  type: "bet" | "endTurn" | "move";
  actionBy: number;
  amount?: number;
  currentTurn?: number;
}

interface SendMessageInput {
  party: boolean;
  token: string;
  msg: string;
};

export interface UseGameSocketReturn extends PeerConnectionResult {
  gameState: GameState;
  wagerAmount: string;
  setWagerAmount: (value: string) => void;
  opponentWager: string;
  log: string[];
  playerHand: string[];
  opponentHand: string[];
  playerCoins: number;
  setPlayerCoins: React.Dispatch<React.SetStateAction<number>>;
  opponentCoins: number;
  isPlayerTurn: boolean;
  playerNumber: number;
}

const SOCKET_URL = "http://localhost:3001";

const useGameSocket = (deliverMessage: (m: string) => void, setSocketEnabled: (e: boolean) => void): UseGameSocketReturn => {
  const searchParams = getSearchParams();
  const token = searchParams.token;
  const iStarted = searchParams.iStarted !== 'false';
  const socketRef = useRef<Socket | null>(null);
  const playerNumberRef = useRef<number>(0);

  const [gameState, setGameState] = useState<GameState>("idle");
  const [wagerAmount, setWagerAmount] = useState<string>("");
  const [opponentWager, setOpponentWager] = useState<string>("");
  const [log, setLog] = useState<string[]>([]);
  const [playerHand, setPlayerHand] = useState<string[]>([]);
  const [opponentHand, setOpponentHand] = useState<string[]>([]);
  const [playerCoins, setPlayerCoins] = useState<number>(100);
  const [opponentCoins, setOpponentCoins] = useState<number>(100);
  const [room, setRoom] = useState<string>("");
  const [isPlayerTurn, setIsPlayerTurn] = useState<boolean>(false);
  const [playerNumber, setPlayerNumber] = useState<number>(0);

  const eff = () => {
    let fullyConnected = false;
    if (!socketRef.current) {
      const socketResult: any = io(SOCKET_URL);
      socketRef.current = socketResult;
    }
    const socket = socketRef.current;

    const handleWaiting = () => {
      setGameState("searching");
    };

    socket?.on("waiting", handleWaiting);

    // Try to get through a 'peer' message until we succeed.
    const beacon = setInterval(() => {
      socketRef.current?.emit('peer', { iStarted });
    }, 500);

    // When we receive a message from our peer, we know we're connected.
    socket?.on('peer', msg => {
      if (msg.iStarted != iStarted && !fullyConnected) {
        // If they haven't seen our message yet, we know we're connected so
        // we can send a ping to them now.
        fullyConnected = true;
        socketRef.current?.emit('peer', { iStarted });
        clearInterval(beacon);
        setSocketEnabled(true);
      }
    });

    socket?.on('game_message', (input: SendMessageInput) => {
      console.log('raw message', input);
      if (input.token !== token || input.party === iStarted) {
        return;
      }

      console.log('got remote message', input.msg);
      deliverMessage(input.msg);
    });

    return () => {
      socket?.off("game_message", handleWaiting);
    };
  };

  eff();

  const sendMessage = (msg: string) => {
    socketRef.current?.emit('game_message', {
      party: iStarted,
      token,
      msg
    });
  };

  return {
    sendMessage,
    gameState,
    wagerAmount,
    setWagerAmount,
    opponentWager,
    log,
    playerHand,
    opponentHand,
    playerCoins,
    setPlayerCoins,
    opponentCoins,
    isPlayerTurn,
    playerNumber,
  };
};

export default useGameSocket;
