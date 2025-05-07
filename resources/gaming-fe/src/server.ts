import express from 'express';
import { createServer } from 'http';
import { setupWebSocket } from './lobby/websocket';
import { initLobby, shutdownLobby } from './lobby/lobbyState';
import cors from 'cors';
import helmet from 'helmet';
import { config } from 'dotenv';

config();

const app = express();
const httpServer = createServer(app);

app.use(helmet());
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  methods: ['GET', 'POST']
}));
app.use(express.json());

const io = setupWebSocket(httpServer);

process.on('SIGTERM', () => {
  shutdownLobby();
  process.exit(0);
});

process.on('SIGINT', () => {
  shutdownLobby();
  process.exit(0);
});

const port = process.env.PORT || 3001;
httpServer.listen(port, () => {
  console.log(`Server running on port ${port}`);
  initLobby();
}); 