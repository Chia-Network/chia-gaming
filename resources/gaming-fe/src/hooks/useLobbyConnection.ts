import { useState, useEffect, useRef, useCallback } from 'react';
import io, { Socket } from 'socket.io-client';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

interface ChatMsgData { text: string; sender: string; }
interface ChatMsg { alias: string; from: string; message: ChatMsgData; }
interface Player { id: string; game: string; parameters: any; }
interface Room  { token: string; host: Player; joiner?: Player; createdAt: number; expiresAt: number; }

const LOBBY_URL = 'http://localhost:3000';

export function useLobbySocket(alias: string) {
  const [uniqueId, setUniqueId] = useState<string>(uuidv4());
  const [players, setPlayers] = useState<Player[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [messages, setMessages] = useState<{ alias: string; content: ChatMsgData }[]>([]);
  const socketRef = useRef<Socket>(undefined);

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
      socket.on('chat_message', (chatMsg: ChatMsg) => {
      const newObject: any = { content: chatMsg.message };
      newObject[chatMsg.alias] = chatMsg.from;
      setMessages(m => [...m, newObject]);
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
      id: uniqueId,
      alias,
      game,
      parameters: { wagerAmount: wager },
    });
    return data.secureUrl as string;
  }, [alias]);

  const joinRoom = useCallback(async (token: string) => {
    const { data } = await axios.post(`${LOBBY_URL}/lobby/join-room`, {
      token,
      id: uniqueId,
      alias,
      game: 'lobby',
      parameters: {},
    });
    return data.room as Room;
  }, [alias]);

  return { players, rooms, messages, sendMessage, generateRoom, joinRoom };
}
