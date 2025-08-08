import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { Player, MatchmakingPreferences, Room } from '../types/lobby';

export const setupWebSocket = (httpServer: HTTPServer) => {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.CLIENT_URL || 'http://localhost:3000',
      methods: ['GET', 'POST']
    }
  });

  return io;
};
