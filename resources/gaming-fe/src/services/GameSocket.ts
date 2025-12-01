import { v4 as uuidv4 } from 'uuid';
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
  msgno: number;
  msg: string;
}

export interface GameSocketReturn {
  sendMessage: (msgno: number, input: string) => void;
  gameState: GameState;
  wagerAmount: string;
  setWagerAmount: (value: string) => void;
  opponentWager: string;
  playerHand: string[];
  opponentHand: string[];
  playerCoins: number;
  setPlayerCoins: (playerCoins: number) => void;
  opponentCoins: number;
  isPlayerTurn: boolean;
  playerNumber: number;
  hostLog: (msg: string) => void;
}

export const getGameSocket = (
  searchParams: any,
  lobbyUrl: string,
  deliverMessage: (msgno: number, m: string) => void,
  setSocketEnabled: (saves: string[]) => void,
  saves: () => string[],
): GameSocketReturn => {
  console.log('gameSocket: lobbyUrl', lobbyUrl);
  const token = searchParams.token;
  const iStarted = searchParams.iStarted !== 'false';

  let socketRef: Socket | null = null;
  let playerNumberRef: number = 0;

  let gameState: GameState = 'idle';
  let wagerAmount = '';
  let opponentWager = '';
  let playerHand: string[] = [];
  let opponentHand: string[] = [];
  let playerCoins = 100;
  let opponentCoins = 100;
  let room = '';
  let isPlayerTurn = false;
  let playerNumber = 0;

  let fullyConnected = false;
  const socketResult: any = io(lobbyUrl);
  socketRef = socketResult;
  const socket = socketRef;

  const hostLog = (msg: string) => {
    console.log('hostLog', msg);
    socket?.emit('log', msg);
  };

  const handleWaiting = () => {
    gameState = 'searching';
  };

  socket?.on('waiting', handleWaiting);

  // Try to get through a 'peer' message until we succeed.
  const beaconId = uuidv4();
  let receivedBeaconId: string | undefined = undefined;
  const beacon = setInterval(() => {
    hostLog(`sending peer msg ${iStarted} ${beaconId}`);
    socketRef?.emit('peer', { iStarted, beaconId });
  }, 500);

  // When we receive a message from our peer, we know we're connected.
  socket?.on('peer', (msg) => {
    if (msg.iStarted == iStarted) {
      return;
    }

    hostLog(`${iStarted} got peer msg ${JSON.stringify(msg)}`);

    if (!fullyConnected) {
      // If they haven't seen our message yet, we know we're connected so
      // we can send a ping to them now.
      hostLog(`${iStarted} fullyConnected`);
      fullyConnected = true;
      clearInterval(beacon);
    }
    if (msg.beaconId != receivedBeaconId) {
      receivedBeaconId = msg.beaconId;
      hostLog(`${iStarted} new beacon id from ${receivedBeaconId}`);
      socketRef?.emit('peer', { iStarted, beaconId });
      socketRef?.emit('saves', { iStarted, saves: saves() });
    }
  });

  socket?.on('saves', (msg) => {
    if (msg.iStarted != iStarted) {
      setSocketEnabled(msg.saves);
    }
  });

  socket?.on('game_message', (input: SendMessageInput) => {
    console.log('raw message', input);
    if (input.token !== token || input.party === iStarted) {
      return;
    }

    console.log('got remote message', input.msg);
    deliverMessage(input.msgno, input.msg);
  });

  const sendMessage = (msgno: number, msg: string) => {
    socketRef?.emit('game_message', {
      party: iStarted,
      msgno,
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
    playerHand,
    opponentHand,
    playerCoins,
    setPlayerCoins,
    opponentCoins,
    isPlayerTurn,
    playerNumber,
    hostLog,
  };
};
