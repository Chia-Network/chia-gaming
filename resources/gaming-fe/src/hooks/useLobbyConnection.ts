import { useState, useEffect, useRef, useCallback } from 'react';
import { ChatMessage, ChatEnvelope, FragmentData, GenerateRoomResult, Room } from '../types/lobby';
import { getFragmentParams, generateOrRetrieveUniqueId } from '../util';
import io, { Socket } from 'socket.io-client';
import axios from 'axios';

interface Player { id: string; alias: string, game: string; walletAddress?: string; parameters: any; }

export function useLobbySocket(alias: string) {
  const LOBBY_URL = process.env.REACT_APP_LOBBY_URL || 'http://localhost:3000';

  const [uniqueId, setUniqueId] = useState<string>(generateOrRetrieveUniqueId());
  const [players, setPlayers] = useState<Player[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [messages, setMessages] = useState<ChatEnvelope[]>([]);
  const socketRef = useRef<Socket>(undefined);
  const [fragment, setFragment] = useState<FragmentData>(getFragmentParams());
  console.log('fragment retrieved', fragment);

  useEffect(() => {
    const socket = io(LOBBY_URL);
    socketRef.current = socket;

    socket.emit('join', { id: uniqueId, alias: alias });

    socket.on('lobby_update', (q: Player[]) => setPlayers(q));
    socket.on('room_update', (r: Room | Room[]) => {
      const updated = Array.isArray(r) ? r : [r];
      // Determine whether we've been connected with someone based on the .host and .joined
      // members of the rooms.
      for (const room of updated) {
        console.log('checking room', room);
        if (!room.host || !room.joiner) {
          continue;
        }
        if (room.host == uniqueId || room.joiner == uniqueId) {
          // This room is inhabited and contains us, redirect.
          console.log('take us to game', room);
          window.location.href = "https://example.com";
          break;
        }
      }
      setRooms(prev => {
        const map = new Map(prev.map(x => [x.token, x]));
        updated.forEach(x => map.set(x.token, x));
        return Array.from(map.values());
      });
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
