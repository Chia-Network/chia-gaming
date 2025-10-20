import { Server as HTTPServer } from 'http';

import { Server as SocketIOServer } from 'socket.io';

import { GAME_SERVICE_URL } from '../settings';

export const setupWebSocket = (httpServer: HTTPServer) => {
  const io = new SocketIOServer(httpServer, {
    cors: {
      // TODO: add the games using us as a tracker to this
      // allowed-origin list
      origin: process.env.CLIENT_URL || GAME_SERVICE_URL,
      methods: ['GET', 'POST'],
    },
  });

  return io;
};
