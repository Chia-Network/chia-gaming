// hooks/useGameSocket.ts
import { useState, useEffect, useRef } from "react";
import io, { Socket } from "socket.io-client";

export type GameState = "idle" | "searching" | "playing";

interface UseGameSocketReturn {
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

const useGameSocket = (): UseGameSocketReturn => {
  const socketRef = useRef<Socket | null>(null);

  if (!socketRef.current) {
    socketRef.current = io("http://localhost:3001");
  }

  const socket = socketRef.current;

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

  useEffect(() => {
    socket.on("waiting", (data: any) => {
      setGameState("searching");
    });

    socket.on("startGame", (data: any) => {
      setGameState("playing");
      setRoom(data.room);
      setLog((prevLog) => [...prevLog, "Opponent found! Starting game..."]);

      setPlayerHand(data.playerHand);
      setOpponentHand(data.opponentHand);

      setPlayerNumber(data.playerNumber);
      playerNumberRef.current = data.playerNumber;

      setOpponentWager(data.opponentWager);
      setWagerAmount(data.wagerAmount);

      setIsPlayerTurn(data.currentTurn === data.playerNumber);
    });

    socket.on("action", (data: any) => {
      const currentPlayerNumber = playerNumberRef.current;
      if (data.type === "bet") {
        if (data.actionBy === currentPlayerNumber) {
          setPlayerCoins((prevCoins) => prevCoins - data.amount);
          setLog((prevLog) => [...prevLog, `You bet ${data.amount} coins.`]);
        } else {
          setOpponentCoins((prevCoins) => prevCoins - data.amount);
          setLog((prevLog) => [
            ...prevLog,
            `Opponent bets ${data.amount} coins.`,
          ]);
        }
      } else if (data.type === "endTurn") {
        setIsPlayerTurn(data.currentTurn === currentPlayerNumber);
        if (data.actionBy === currentPlayerNumber) {
          setLog((prevLog) => [...prevLog, "You ended your turn."]);
        } else {
          setLog((prevLog) => [...prevLog, "Opponent ended their turn."]);
        }
      } else if (data.type === "move") {
        if (data.actionBy === currentPlayerNumber) {
          setLog((prevLog) => [...prevLog, "You made a move."]);
        } else {
          setLog((prevLog) => [...prevLog, "Opponent made a move."]);
        }
      }
    });

    return () => {
      socket.off("waiting");
      socket.off("startGame");
      socket.off("action");
    };
  }, []);

  const handleFindOpponent = () => {
    console.info("handle find opponent");
    if (wagerAmount === "") {
      alert("Please enter a wager amount.");
      return;
    }
    socket.emit("findOpponent", { wagerAmount });
  };

  const handleEndTurn = (): void => {
    if (!isPlayerTurn) {
      alert("It's not your turn.");
      return;
    }

    socket.emit("action", {
      room,
      type: "endTurn",
      actionBy: playerNumberRef.current,
    });
  };

  const handleBet = (amount: number): void => {
    if (!isPlayerTurn) {
      alert("It's not your turn.");
      return;
    }

    if (playerCoins >= amount) {
      socket.emit("action", {
        room,
        type: "bet",
        amount,
        actionBy: playerNumberRef.current,
      });
    } else {
      alert("You don't have enough coins.");
    }
  };

  const handleMakeMove = (): void => {
    if (!isPlayerTurn) {
      alert("It's not your turn.");
      return;
    }
    socket.emit("action", {
      room,
      type: "move",
      actionBy: playerNumberRef.current,
    });
  };

  return {
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
