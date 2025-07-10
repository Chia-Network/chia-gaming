import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import {
  addPlayer,
  removePlayer,
  createRoom,
  joinRoom,
  leaveRoom,
  findMatch,
  getPlayers,
  getRooms,
  updatePlayerStatus,
} from './lobbyState';
import { Player, MatchmakingPreferences, Room } from '../types/lobby';

export const setupWebSocket = (httpServer: HTTPServer) => {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.CLIENT_URL || 'http://localhost:3000',
      methods: ['GET', 'POST']
    }
  });

  io.on('connection', socket => {
    let currentPlayer: Player | null = null;

    socket.emit('lobby_update', getPlayers());
    socket.emit('room_update', getRooms());

    socket.on('join_lobby', (preferences: MatchmakingPreferences) => {
      const player: Player = {
        id: preferences.id,
        alias: preferences.alias,
        parameters: preferences.parameters,
        walletAddress: '', // TODO: Get from auth
        joinedAt: Date.now(),
        lastActive: Date.now(),
        status: 'waiting'
      };

      currentPlayer = addPlayer(player);
      io.emit('lobby_update', getPlayers());

      const match = findMatch(player, preferences);
      if (match) {
        socket.emit('match_found', match);
      }
    });

    socket.on('leave_lobby', () => {
      if (currentPlayer) {
        removePlayer(currentPlayer.id);
        io.emit('lobby_update', getPlayers());
        currentPlayer = null;
      }
    });

    socket.on('create_room', (preferences: MatchmakingPreferences) => {
      if (!currentPlayer) {
        socket.emit('error', { code: 'NOT_IN_LOBBY', message: 'Must join lobby first' });
        return;
      }

      const room = createRoom(currentPlayer.id, preferences);
      socket.join(room.token);
      io.emit('room_update', getRooms());
    });

    socket.on('join_room', (roomId: string) => {
      if (!currentPlayer) {
        socket.emit('error', { code: 'NOT_IN_LOBBY', message: 'Must join lobby first' });
        return;
      }

      const room = joinRoom(roomId, currentPlayer);
      if (!room) {
        socket.emit('error', { code: 'ROOM_FULL', message: 'Room is full or not available' });
        return;
      }

      socket.join(room.token);
      io.to(room.token).emit('room_update', room);
      io.emit('room_update', getRooms());
    });

    socket.on('leave_room', (roomId: string) => {
      if (!currentPlayer) return;

      if (leaveRoom(roomId, currentPlayer.id)) {
        socket.leave(roomId);
        io.to(roomId).emit('room_update', getRooms().find(r => r.token === roomId));
        io.emit('room_update', getRooms());
      }
    });

    socket.on('ready', (roomId: string) => {
      if (!currentPlayer) return;

      updatePlayerStatus(currentPlayer.id, 'matched');
      io.to(roomId).emit('player_ready', { playerId: currentPlayer.id });
    });

    socket.on('game_message', ({ party, token, msg }) => {
      console.log('game message', party, token, msg);
      io.emit('game_message', { party, token, msg });
    });

    socket.on('peer', ({ iStarted }) => {
      console.log('peer', iStarted);
      io.emit('peer', { iStarted });
    });

    socket.on('chat_message', ({ roomId, text }: { roomId: string; text: string }) => {
      if (!currentPlayer) return;

      io.to(roomId).emit('chat_message', {
        playerId: currentPlayer.id,
        text,
        timestamp: Date.now()
      });
    });

    socket.on('disconnect', () => {
      if (currentPlayer) {
        removePlayer(currentPlayer.id);
        io.emit('lobby_update', getPlayers());
        io.emit('room_update', getRooms());
      }
    });
  });

  return io;
}; 
