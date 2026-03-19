import { v4 as uuidv4 } from 'uuid';
import io, { Socket } from 'socket.io-client';
import { PeerIdentity } from '../types/ChiaGaming';

interface SendMessageInput {
  party: boolean;
  token: string;
  msgno: number;
  msg: string;
}

export interface GameSocketReturn {
  sendMessage: (msgno: number, input: string) => void;
  hostLog: (msg: string) => void;
}

export const getGameSocket = (
  peerIdentity: PeerIdentity,
  lobbyUrl: string,
  deliverMessage: (msgno: number, m: string) => void,
  setSocketEnabled: (saves: string[]) => void,
  saves: () => string[],
): GameSocketReturn => {
  const { token, iStarted } = peerIdentity;

  let socketRef: Socket | null = null;

  let fullyConnected = false;
  socketRef = io(lobbyUrl);
  const socket = socketRef;

  const hostLog = (msg: string) => {
    socket?.emit('log', msg);
  };

  const beaconId = uuidv4();
  let receivedBeaconId: string | undefined = undefined;
  const beacon = setInterval(() => {
    socketRef?.emit('peer', { iStarted, beaconId, token });
  }, 500);

  socket?.on('peer', (msg) => {
    if (msg.iStarted == iStarted || msg.token !== token) {
      return;
    }
    if (!fullyConnected) {
      fullyConnected = true;
      clearInterval(beacon);
    }
    if (msg.beaconId != receivedBeaconId) {
      receivedBeaconId = msg.beaconId;
      socketRef?.emit('peer', { iStarted, beaconId, token });
      socketRef?.emit('saves', { iStarted, token, saves: saves() });
    }
  });

  socket?.on('saves', (msg) => {
    if (msg.iStarted != iStarted || msg.token !== token) {
      setSocketEnabled(msg.saves);
    }
  });

  socket?.on('game_message', (input: SendMessageInput) => {
    if (input.token !== token || input.party === iStarted) {
      return;
    }

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

  return {
    sendMessage,
    hostLog,
  };
};
