import { useState, useEffect, useRef, useCallback } from 'react';
import { ChatMessage, ChatEnvelope, FragmentData, GenerateRoomResult, Room } from '../types/lobby';
import { getSearchParams, getFragmentParams, generateOrRetrieveUniqueId } from '../util';
import io, { Socket } from 'socket.io-client';
import axios from 'axios';

interface Player { id: string; alias: string, game: string; walletAddress?: string; parameters: any; }

export function useLobbySocket(alias: string, walletConnect: boolean) {
  const LOBBY_URL = window.location.origin;
  const params = getSearchParams();
  const [uniqueId, setUniqueId] = useState<string>(generateOrRetrieveUniqueId());
  const [players, setPlayers] = useState<Player[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [messages, setMessages] = useState<ChatEnvelope[]>([]);
  const socketRef = useRef<Socket>(undefined);
  const [fragment, setFragment] = useState<FragmentData>(getFragmentParams());
  console.log('fragment retrieved', fragment);

  function tryJoinRoom() {
    for (let i = 0; i < rooms.length; i++) {
      let room = rooms[i];
      console.log('we have: uniqueId', uniqueId, 'params', params);
      window.parent.postMessage({
        name: 'lobby'
      }, '*');
      console.log('checking room', room);
      if (!room.host || !room.joiner) {
        console.log('either host or joiner missing');
        continue;
      }
      console.log('conditions to enter', room.host === uniqueId, room.joiner === uniqueId, room.target, walletConnect);
      if ((room.host === uniqueId || room.joiner === uniqueId) && room.target && walletConnect) {
        const iStarted = room.host === uniqueId;
        // This room is inhabited and contains us, redirect.
        console.log('take us to game', JSON.stringify(room));
        window.location.href = `${room.target}&uniqueId=${uniqueId}&iStarted=${iStarted}` as string;
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

  return { players, rooms, messages, sendMessage, generateRoom, joinRoom, leaveRoom, setLobbyAlias, uniqueId, fragment };
}
