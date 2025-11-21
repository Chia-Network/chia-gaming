import { getSearchParams } from '../util';
import io, { Socket } from 'socket.io-client';

export type GameState = 'idle' | 'searching' | 'playing';

interface StartGameData {
  playerHand: string[];
  opponentHand: string[];
  playerNumber: number;
  opponentWager: string;
  wagerAmount: string;
  currentTurn: number;
}

interface ActionData {
  type: 'bet' | 'endTurn' | 'move';
  actionBy: number;
  amount?: number;
  currentTurn?: number;
}

interface SendMessageInput {
  party: boolean;
  token: string;
  msg: string;
}

export interface GameSocketReturn {
  sendMessage: (input: string) => void;
  gameState: GameState;
  wagerAmount: string;
  setWagerAmount: (value: string) => void;
  opponentWager: string;
  log: string[];
  playerHand: string[];
  opponentHand: string[];
  playerCoins: number;
  setPlayerCoins: (playerCoins: number) => void;
  opponentCoins: number;
  isPlayerTurn: boolean;
  playerNumber: number;
}

export const getGameSocket = (
  lobbyUrl: string,
  deliverMessage: (m: string) => void,
  setSocketEnabled: (saves: string[]) => void,
  saves: string[],
): GameSocketReturn => {
  const searchParams = getSearchParams();
  const token = searchParams.token;
  const iStarted = searchParams.iStarted !== 'false';

  let socketRef: Socket | null = null;
  let playerNumberRef: number = 0;

  let gameState: GameState = 'idle';
  let wagerAmount = '';
  let opponentWager = '';
  let log: string[] = [];
  let playerHand: string[] = [];
  let opponentHand: string[] = [];
  let playerCoins = 100;
  let opponentCoins = 100;
  let room = '';
  let isPlayerTurn = false;
  let playerNumber = 0;

  const eff = () => {
    let fullyConnected = false;
    if (!socketRef) {
      const socketResult: any = io(lobbyUrl);
      socketRef = socketResult;
    }
    const socket = socketRef;

    const handleWaiting = () => {
      gameState = 'searching';
    };

    socket?.on('waiting', handleWaiting);

    // Try to get through a 'peer' message until we succeed.
    const beacon = setInterval(() => {
      socketRef?.emit('peer', { iStarted, saves });
    }, 500);

    // When we receive a message from our peer, we know we're connected.
    socket?.on('peer', (msg) => {
      if (msg.iStarted != iStarted && !fullyConnected) {
        // If they haven't seen our message yet, we know we're connected so
        // we can send a ping to them now.
        fullyConnected = true;
        socketRef?.emit('peer', { iStarted, saves });
        clearInterval(beacon);
        setSocketEnabled(msg.saves);
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
      socket?.off('game_message', handleWaiting);
    };
  };

  eff();

  const sendMessage = (msg: string) => {
    socketRef?.emit('game_message', {
      party: iStarted,
      token,
      msg,
    });
  };

  let setWagerAmount = (newWager: string) => {
    wagerAmount = newWager;
  };

  let setPlayerCoins = (newPlayerCoins: number) => {
    playerCoins = newPlayerCoins;
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
