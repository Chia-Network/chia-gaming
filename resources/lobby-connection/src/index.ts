import React from 'react';
import { useState, useEffect, useCallback, useRef } from 'react';
import io, { Socket } from 'socket.io-client';

export type GameState = 'idle' | 'searching' | 'playing';

export type FragmentData = Record<string, string>;

interface SendMessageInput {
  party: boolean;
  token: string;
  msg: string;
}

export interface UseGameSocketReturn {
  sendMessage: (input: string) => void;
  gameState: GameState;
  wagerAmount: string;
  setWagerAmount: (value: string) => void;
  playerCoins: number;
  setPlayerCoins: React.Dispatch<React.SetStateAction<number>>;
  isPlayerTurn: boolean;
  playerNumber: number;
}

export const GameTypes = {
  CALIFORNIA_POKER: 'california_poker',
  KRUNK: 'krunk',
  EXOTIC_POKER: 'exotic_poker',
};
export type GameType = 'california_poker' | 'krunk' | 'exotic_poker';

export interface Room {
  token: string;
  host: string;
  target?: string;
  joiner?: string;
  game: GameType;
  minPlayers: number;
  maxPlayers: number;
  status: 'waiting' | 'in_progress' | 'completed';
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  expiresAt: number;
  parameters: any;
  chat: ChatMessage[];
}

export interface GenerateRoomResult {
  secureUrl: string;
  token: string;
}

export interface ChatMessage {
  sender?: string;
  text: string;
  timestamp?: number;
}

export interface ChatEnvelope {
  alias: string;
  content: ChatMessage;
}

const useGameSocket = (
  lobbyUrl: string,
  deliverMessage: (m: string) => void,
  setSocketEnabled: (e: boolean) => void,
  searchParams: any
): UseGameSocketReturn => {
  const token = searchParams.token;
  const iStarted = searchParams.iStarted !== 'false';
  const socketRef = useRef<Socket | null>(null);

  const [gameState, setGameState] = useState<GameState>('idle');
  const [wagerAmount, setWagerAmount] = useState<string>('');
  const [playerCoins, setPlayerCoins] = useState<number>(100);
  const [isPlayerTurn] = useState<boolean>(false);
  const [playerNumber] = useState<number>(0);

  const eff = () => {
    let fullyConnected = false;
    if (!socketRef.current) {
      const socketResult: any = io(lobbyUrl);
      socketRef.current = socketResult;
    }
    const socket = socketRef.current;

    const handleWaiting = () => {
      setGameState('searching');
    };

    socket?.on('waiting', handleWaiting);

    // Try to get through a 'peer' message until we succeed.
    const beacon = setInterval(() => {
      socketRef.current?.emit('peer', { iStarted });
    }, 500);

    // When we receive a message from our peer, we know we're connected.
    socket?.on('peer', (msg: any) => {
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
      socket?.off('game_message', handleWaiting);
    };
  };

  eff();

  const sendMessage = (msg: string) => {
    socketRef.current?.emit('game_message', {
      party: iStarted,
      token,
      msg,
    });
  };

  return {
    sendMessage,
    gameState,
    wagerAmount,
    setWagerAmount,
    playerCoins,
    setPlayerCoins,
    isPlayerTurn,
    playerNumber,
  };
};

interface Player {
  id: string;
  alias: string;
  game: string;
  walletAddress?: string;
  parameters: any;
}

export function useLobbySocket(
  lobbyUrl: string,
  uniqueId: string,
  alias: string,
  walletConnect: boolean,
  params: any,
  fragment: any,
  navigate: (url: string) => void,
) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [messages, setMessages] = useState<ChatEnvelope[]>([]);
  const [didJoin, setDidJoin] = useState(false);
  const socketRef = useRef<Socket>(undefined);
  console.log('fragment retrieved', fragment);

  const joinRoom = useCallback(
    async (token: string) => {
      const { data } = await fetch(
        `${lobbyUrl}/lobby/join-room`,
        {
          method: "POST",
          body: JSON.stringify({
            token,
            id: uniqueId,
            alias,
            game: 'lobby',
            parameters: {},
          }),
          headers: { "Content-Type": "application/json" }
        }
      ).then(res => res.json());

      return data.room as Room;
    },
    [uniqueId],
  );

  function tryJoinRoom() {
    for (const room of rooms) {
      console.log('we have: uniqueId', uniqueId, 'params', params);
      console.log('checking room', room);
      if (!room.host) {
        console.log('either host or joiner missing');
        continue;
      }
      if (params.token && room.token != params.token) {
        console.log('room with wrong token wanted', params.token);
        continue;
      }

      if (params.token && room.host != uniqueId && !room.joiner && !didJoin) {
        // We know this is the room we want and we're the joiner.  Join it.
        // We'll get an update and ungate the rest.
        setDidJoin(true);
        joinRoom(params.token);
        continue;
      }

      console.log(
        'conditions to enter',
        room.host === uniqueId,
        room.joiner === uniqueId,
        room.target,
        walletConnect,
      );
      if (
        (room.host === uniqueId || room.joiner === uniqueId) &&
        room.target &&
        walletConnect
      ) {
        const iStarted = room.host === uniqueId;
        // This room is inhabited and contains us, redirect.
        console.log('take us to game', JSON.stringify(room));
        // This is gross but should work ok.
        fetch('/lobby/good', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            id: uniqueId,
            token: room.token,
          }),
        })
          .then((res) => res.json())
          .then(() => {
            const newUrl =
              `${room.target}&uniqueId=${uniqueId}&iStarted=${iStarted}` as string;
            return navigate(newUrl);
          });
        break;
      }
    }
  }

  tryJoinRoom();

  useEffect(() => {
    const socket = io(lobbyUrl);
    socketRef.current = socket;

    socket.emit('join', { id: uniqueId, alias: alias });

    socket.on('lobby_update', (q: Player[]) => setPlayers(q));
    socket.on('room_update', (r: Room | Room[]) => {
      const updated = Array.isArray(r) ? r : [r];
      // Determine whether we've been connected with someone based on the .host and .joined
      // members of the rooms.
      setRooms((prev: Room[]) => {
        const map = new Map(prev.map((x: Room) => [x.token, x]));
        updated.forEach((x: Room) => map.set(x.token, x));
        return Array.from(map.values());
      });

      tryJoinRoom();
    });
    socket.on('chat_message', (chatMsg: ChatEnvelope) => {
      setMessages((m: ChatEnvelope[]) => [...m, chatMsg]);
    });

    return () => {
      socket.emit('leave', { id: alias });
      socket.disconnect();
    };
  }, [uniqueId]);

  const sendMessage = useCallback(
    (msg: string) => {
      socketRef.current?.emit('chat_message', {
        alias,
        content: { text: msg, sender: alias },
      });
    },
    [uniqueId],
  );

  const generateRoom = useCallback(
    async (
      game: string,
      amount: string,
      perGame: string,
    ): Promise<GenerateRoomResult> => {
      const data = await fetch(
        `${lobbyUrl}/lobby/generate-room`, {
          method: "POST",
          body: JSON.stringify({
            id: uniqueId,
            alias,
            game,
            parameters: { amount, perGame },
          }),
          headers: { "Content-Type": "application/json" }
        }
      ).then(res => res.json());
      return data;
    },
    [uniqueId],
  );

  const setLobbyAlias = useCallback(
    async (id: string, alias: string) => {
      console.log('setLobbyAlias', id, alias);
      const { data } = await fetch(
        `${lobbyUrl}/lobby/change-alias`, {
          method: "POST",
          body: JSON.stringify({
            id,
            newAlias: alias,
          }),
          headers: { "Content-Type": "application/json" }
        }
      ).then(res => res.json());
      return data.player;
    },
    [uniqueId],
  );

  const leaveRoom = useCallback(
    async (_token: string) => {
      console.error('implement leave room');
    },
    [uniqueId],
  );

  return {
    players,
    rooms,
    messages,
    sendMessage,
    generateRoom,
    joinRoom,
    leaveRoom,
    setLobbyAlias,
    uniqueId,
    fragment,
  };
}

export default useGameSocket;
