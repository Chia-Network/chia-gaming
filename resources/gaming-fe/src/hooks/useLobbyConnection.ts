import { useState, useEffect, useRef, useCallback } from 'react';
import { ChatMessage, ChatEnvelope, GenerateRoomResult, Room } from '../types/lobby';
import { FragmentData } from '../util';
import { getFragmentParams, generateOrRetrieveUniqueId } from '../util';
import io, { Socket } from 'socket.io-client';
import axios from 'axios';

interface Player { id: string; alias: string, game: string; walletAddress?: string; parameters: any; }

export function useLobbySocket(alias: string) {
  const LOBBY_URL = process.env.REACT_APP_LOBBY_URL || 'http://localhost:3000';
  const BLOCKCHAIN_SERVICE_URL = process.env.REACT_APP_BLOCKCHAIN_SERVICE_URL || 'http://localhost:5800';

  const [uniqueId, setUniqueId] = useState<string>(generateOrRetrieveUniqueId());
  const [players, setPlayers] = useState<Player[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [messages, setMessages] = useState<ChatEnvelope[]>([]);
  const socketRef = useRef<Socket>(undefined);
  const [fragment, setFragment] = useState<FragmentData>(getFragmentParams());
  const [walletToken, setWalletToken] = useState<string | undefined>(undefined);
  console.log('fragment retrieved', fragment);

  function tryJoinRoom() {
    for (let i = 0; i < rooms.length; i++) {
      let room = rooms[i];
      console.log('checking room', room);
      if (!room.host || !room.joiner) {
        continue;
      }
      if (room.host === uniqueId || room.joiner === uniqueId && room.target && walletToken) {
        const iStarted = room.host === uniqueId;
        // This room is inhabited and contains us, redirect.
        console.log('take us to game', JSON.stringify(room));
        window.location.href = `${room.target}&walletToken=${walletToken}&uniqueId=${uniqueId}&iStarted=${iStarted}` as string;
        break;
      }
    }
  }

  tryJoinRoom();

  useEffect(() => {
    const socket = io(LOBBY_URL);
    socketRef.current = socket;

    socket.emit('join', { id: uniqueId, alias: alias });

    socket.on('lobby_update', (q: Player[]) => setPlayers(q));
    socket.on('room_update', (r: Room | Room[]) => {
      const updated = Array.isArray(r) ? r : [r];
      // Determine whether we've been connected with someone based on the .host and .joined
      // members of the rooms.
      setRooms(prev => {
        const map = new Map(prev.map(x => [x.token, x]));
        updated.forEach(x => map.set(x.token, x));
        return Array.from(map.values());
      });

      tryJoinRoom();
    });
      socket.on('chat_message', (chatMsg: ChatEnvelope) => {
      setMessages(m => [...m, chatMsg]);
    });

    return () => {
      socket.emit('leave', { id: alias });
      socket.disconnect();
    };
  }, [uniqueId]);

  useEffect(() => {
    fetch(`${BLOCKCHAIN_SERVICE_URL}/register?name=${uniqueId}`, {
      method: 'POST',
      body: ''
    }).then(result => result.json()).then(publicKey => {
      console.log(`wallet token ${publicKey}`);
      setWalletToken(publicKey);
      tryJoinRoom();
    });
  });

  const sendMessage = useCallback((msg: string) => {
    socketRef.current?.emit('chat_message', { alias, content: { text: msg, sender: alias } });
  }, [uniqueId]);

  const generateRoom = useCallback(async (game: string, wager: string): Promise<GenerateRoomResult> => {
    const { data } = await axios.post(`${LOBBY_URL}/lobby/generate-room`, {
      id: uniqueId,
      alias,
      game,
      parameters: { wagerAmount: wager },
    });
    return data;
  }, [uniqueId]);

  const joinRoom = useCallback(async (token: string) => {
    const { data } = await axios.post(`${LOBBY_URL}/lobby/join-room`, {
      token,
      id: uniqueId,
      alias,
      game: 'lobby',
      parameters: {},
    });
    return data.room as Room;
  }, [uniqueId]);

  const setLobbyAlias = useCallback(async (id: string, alias: string) => {
    console.log('setLobbyAlias', id, alias);
    const { data } = await axios.post(`${LOBBY_URL}/lobby/change-alias`, {
      id, newAlias: alias
    });
    return data.player;
  }, [uniqueId]);

  const leaveRoom = useCallback(async (token: string) => {
    console.error('implement leave room');
  }, [uniqueId]);

  return { players, rooms, messages, sendMessage, generateRoom, joinRoom, leaveRoom, setLobbyAlias, uniqueId, fragment, walletToken };
}
