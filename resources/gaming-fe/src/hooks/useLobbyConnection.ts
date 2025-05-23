import { useState, useEffect, useRef, useCallback } from 'react';
import io, { Socket } from 'socket.io-client';
import axios from 'axios';

interface Player { id: string; game: string; parameters: any; }
interface Room  { token: string; host: Player; joiner?: Player; createdAt: number; expiresAt: number; }

const LOBBY_URL = 'http://localhost:3000';

export function useLobbySocket(alias: string) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [messages, setMessages] = useState<{ alias: string; content: string }[]>([]);
  const socketRef = useRef<Socket>();

  useEffect(() => {
    const socket = io(LOBBY_URL);
    socketRef.current = socket;

    socket.emit('join', { id: alias });

    socket.on('lobby_update', (q: Player[]) => setPlayers(q));
    socket.on('room_update', (r: Room | Room[]) => {
      const updated = Array.isArray(r) ? r : [r];
      setRooms(prev => {
        const map = new Map(prev.map(x => [x.token, x]));
        updated.forEach(x => map.set(x.token, x));
        return Array.from(map.values());
      });
    });
    socket.on('chat_message', ({ alias: from, message }) => {
      setMessages(m => [...m, { alias: from, content: message }]);
    });

    return () => {
      socket.emit('leave', { id: alias });
      socket.disconnect();
    };
  }, [alias]);

  const sendMessage = useCallback((msg: string) => {
    socketRef.current?.emit('chat_message', { alias, message: msg });
  }, [alias]);

  const generateRoom = useCallback(async (game: string, wager: string) => {
    const { data } = await axios.post(`${LOBBY_URL}/lobby/generate-room`, {
      id: alias,
      game,
      parameters: { wagerAmount: wager },
    });
    return data.secureUrl as string;
  }, [alias]);

  const joinRoom = useCallback(async (token: string) => {
    const { data } = await axios.post(`${LOBBY_URL}/lobby/join-room`, {
      token,
      id: alias,
      game: 'lobby',
      parameters: {},
    });
    return data.room as Room;
  }, [alias]);

  return { players, rooms, messages, sendMessage, generateRoom, joinRoom };
}