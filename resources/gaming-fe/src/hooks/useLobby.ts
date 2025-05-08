import { useState, useEffect, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useWalletConnect } from './useWalletConnect';
import { Player, Room, GameType, MatchmakingPreferences } from '../types/lobby';

interface LobbyState {
  players: Player[];
  rooms: Room[];
  currentRoom?: Room;
  error?: string;
}

export const useLobby = () => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [state, setState] = useState<LobbyState>({
    players: [],
    rooms: []
  });
  const { isConnected, address, signMessage } = useWalletConnect();

  const connect = useCallback(() => {
    const newSocket = io(process.env.REACT_APP_LOBBY_URL || 'http://localhost:3001', {
      auth: {
        token: localStorage.getItem('auth_token')
      }
    });

    newSocket.on('lobby_update', (players: Player[]) => {
      setState(prev => ({ ...prev, players }));
    });

    newSocket.on('room_update', (rooms: Room[]) => {
      setState(prev => ({ ...prev, rooms }));
    });

    newSocket.on('match_found', (room: Room) => {
      setState(prev => ({ ...prev, currentRoom: room }));
    });

    newSocket.on('error', (error: { code: string; message: string }) => {
      setState(prev => ({ ...prev, error: error.message }));
    });

    setSocket(newSocket);

    return () => {
      newSocket.close();
    };
  }, []);

  const joinLobby = useCallback(async (preferences: MatchmakingPreferences) => {
    if (!socket || !address) return;

    try {
      const message = `Join lobby: ${JSON.stringify(preferences)}`;
      const signature = await signMessage(message);

      socket.emit('join_lobby', {
        ...preferences,
        signature
      });
    } catch (error) {
      setState(prev => ({
        ...prev,
        error: 'Failed to join lobby'
      }));
    }
  }, [socket, address, signMessage]);

  const leaveLobby = useCallback(() => {
    if (!socket) return;
    socket.emit('leave_lobby');
  }, [socket]);

  const createRoom = useCallback(async (preferences: MatchmakingPreferences) => {
    if (!socket || !address) return;

    try {
      const message = `Create room: ${JSON.stringify(preferences)}`;
      const signature = await signMessage(message);

      socket.emit('create_room', {
        ...preferences,
        signature
      });
    } catch (error) {
      setState(prev => ({
        ...prev,
        error: 'Failed to create room'
      }));
    }
  }, [socket, address, signMessage]);

  const joinRoom = useCallback(async (roomId: string) => {
    if (!socket || !address) return;

    try {
      const message = `Join room: ${roomId}`;
      const signature = await signMessage(message);

      socket.emit('join_room', {
        roomId,
        signature
      });
    } catch (error) {
      setState(prev => ({
        ...prev,
        error: 'Failed to join room'
      }));
    }
  }, [socket, address, signMessage]);

  const leaveRoom = useCallback((roomId: string) => {
    if (!socket) return;
    socket.emit('leave_room', roomId);
  }, [socket]);

  const sendChatMessage = useCallback((roomId: string, text: string) => {
    if (!socket) return;
    socket.emit('chat_message', { roomId, text });
  }, [socket]);

  useEffect(() => {
    if (isConnected) {
      return connect();
    }
  }, [isConnected, connect]);

  return {
    ...state,
    joinLobby,
    leaveLobby,
    createRoom,
    joinRoom,
    leaveRoom,
    sendChatMessage
  };
}; 