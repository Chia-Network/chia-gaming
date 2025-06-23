import { useState, useEffect, useRef, useCallback } from "react";
import { getSearchParams } from '../util';
import io, { Socket } from "socket.io-client";

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

export interface UseGameSocketReturn {
  incomingMessages: string[];
  setIncomingMessages: (msgs: string[]) => void;
  sendMessage: (input: SendMessageInput) => void;
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
  handleFindOpponent: () => void;
  handleBet: (amount: number) => void;
  handleMakeMove: () => void;
  handleEndTurn: () => void;
}

const SOCKET_URL = "http://localhost:3001";

const useGameSocket = (): UseGameSocketReturn => {
  const searchParams = getSearchParams();
  const token = searchParams.token;
  const iStarted = searchParams.iStarted !== 'false';
  const socketRef = useRef<Socket | null>(null);
  const playerNumberRef = useRef<number>(0);

  const [gameState, setGameState] = useState<GameState>("idle");
  const [incomingMessages, setIncomingMessages] = useState<string[]>([]);
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

  useEffect(() => {
    if (!socketRef.current) {
      const socketResult: any = io(SOCKET_URL);
      socketRef.current = socketResult;
    }
    const socket = socketRef.current;

    const handleWaiting = () => {
      setGameState("searching");
    };

    const handleStartGame = (data: StartGameData) => {
      setGameState("playing");
      setLog((prev) => [...prev, "Opponent found! Starting game..."]);
      setPlayerHand(data.playerHand);
      setOpponentHand(data.opponentHand);
      setPlayerNumber(data.playerNumber);
      playerNumberRef.current = data.playerNumber;
      setOpponentWager(data.opponentWager);
      setWagerAmount(data.wagerAmount);
      setIsPlayerTurn(data.currentTurn === data.playerNumber);
    };

    const handleAction = (data: ActionData) => {
      const currentPlayer = playerNumberRef.current;
      switch (data.type) {
        case "bet":
          if (data.actionBy === currentPlayer) {
            setPlayerCoins((coins) => coins - (data.amount || 0));
            setLog((prev) => [...prev, `You bet ${data.amount} coins.`]);
          } else {
            setOpponentCoins((coins) => coins - (data.amount || 0));
            setLog((prev) => [...prev, `Opponent bets ${data.amount} coins.`]);
          }
          break;
        case "endTurn":
          setIsPlayerTurn(data.currentTurn === currentPlayer);
          setLog((prev) => [
            ...prev,
            data.actionBy === currentPlayer
              ? "You ended your turn."
              : "Opponent ended their turn.",
          ]);
          break;
        case "move":
          setLog((prev) => [
            ...prev,
            data.actionBy === currentPlayer
              ? "You made a move."
              : "Opponent made a move.",
          ]);
          break;
        default:
          break;
      }
    };

    socket?.on("waiting", handleWaiting);
    socket?.on("startGame", handleStartGame);
    socket?.on("action", handleAction);

    socket?.on('game_message', (input: SendMessageInput) => {
      if (input.token !== token || input.party === iStarted) {
        return;
      }

      console.log('got remote message', input.msg);
      let new_im = [...incomingMessages, input.msg];
      setIncomingMessages(new_im);
    });

    return () => {
      socket?.off("waiting", handleWaiting);
      socket?.off("startGame", handleStartGame);
      socket?.off("action", handleAction);
    };
  }, []);

  const sendMessage = useCallback((input: SendMessageInput) => {
    socketRef.current?.emit('game_message', input);
  }, []);

  const handleFindOpponent = useCallback(() => {
    if (!wagerAmount) {
      alert("Please enter a wager amount.");
      return;
    }
    socketRef.current?.emit("findOpponent", { wagerAmount });
  }, [wagerAmount]);

  const handleEndTurn = useCallback(() => {
    if (!isPlayerTurn) {
      alert("It's not your turn.");
      return;
    }
    socketRef.current?.emit("action", {
      room,
      type: "endTurn",
      actionBy: playerNumberRef.current,
    });
  }, [isPlayerTurn, room]);

  const handleBet = useCallback(
    (amount: number) => {
      if (!isPlayerTurn) {
        alert("It's not your turn.");
        return;
      }
      if (playerCoins < amount) {
        alert("You don't have enough coins.");
        return;
      }
      socketRef.current?.emit("action", {
        room,
        type: "bet",
        amount,
        actionBy: playerNumberRef.current,
      });
    },
    [isPlayerTurn, playerCoins, room]
  );

  const handleMakeMove = useCallback(() => {
    if (!isPlayerTurn) {
      alert("It's not your turn.");
      return;
    }
    socketRef.current?.emit("action", {
      room,
      type: "move",
      actionBy: playerNumberRef.current,
    });
  }, [isPlayerTurn, room]);

  return {
    sendMessage,
    incomingMessages,
    setIncomingMessages,
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
    handleFindOpponent,
    handleBet,
    handleMakeMove,
    handleEndTurn,
  };
};

export default useGameSocket;
