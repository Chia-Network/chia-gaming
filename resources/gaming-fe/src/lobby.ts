import express from 'express';
import { createServer } from 'http';
import { setupWebSocket } from './lobby/websocket';
import { initLobby, shutdownLobby } from './lobby/lobbyState';
import { readFile } from 'node:fs/promises';
import { Server } from 'socket.io';
import http from 'http';

const SocketServer: any = Server;
const app = (express as any)();
const server = http.createServer(app);

const io = new SocketServer(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

let waitingPlayer: any | null = null;
interface FindOpponentData { wagerAmount: number; }

io.on("connection", (socket: any) => {
  console.log("A user connected:", socket.id);

  socket.on("findOpponent", (data: FindOpponentData) => {
    socket.wagerAmount = data.wagerAmount;

    if (waitingPlayer) {
      const roomName = `room-${waitingPlayer.id}-${socket.id}`;
      socket.join(roomName);
      waitingPlayer.join(roomName);

      const deck = createDeck();
      shuffleDeck(deck);

      const playerHand = deck.slice(0, 5);
      const opponentHand = deck.slice(5, 10);

      const startingPlayerNumber = Math.random() >= 0.5 ? 1 : 2;

      io.to(waitingPlayer.id).emit("startGame", {
        room: roomName,
        playerHand: playerHand,
        opponentHand: opponentHand,
        playerNumber: 1,
        opponentWager: socket.wagerAmount,
        wagerAmount: waitingPlayer.wagerAmount,
        currentTurn: startingPlayerNumber,
      });

      io.to(socket.id).emit("startGame", {
        room: roomName,
        playerHand: opponentHand,
        opponentHand: playerHand,
        playerNumber: 2,
        opponentWager: waitingPlayer.wagerAmount,
        wagerAmount: socket.wagerAmount,
        currentTurn: startingPlayerNumber,
      });

      waitingPlayer = null;
    } else {
      waitingPlayer = socket;
      socket.emit("waiting", { message: "Waiting for an opponent..." });
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }
  });

  socket.on("action", (data: any) => {
    if (data.type === "bet") {
      io.in(data.room).emit("action", data);
    } else if (data.type === "endTurn") {
      const nextTurn = data.actionBy === 1 ? 2 : 1;

      io.in(data.room).emit("action", {
        type: "endTurn",
        actionBy: data.actionBy,
        currentTurn: nextTurn,
      });
    } else if (data.type === "move") {
      io.in(data.room).emit("action", data);
    }
  });
});

const createDeck = () => {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = [
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "J",
    "Q",
    "K",
    "A",
  ];
  const deck = [];
  for (let suit of suits) {
    for (let rank of ranks) {
      deck.push(`${rank}${suit}`);
    }
  }
  return deck;
};

const shuffleDeck = (deck: string[]) => {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
};

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Kick the root.
async function serveFile(file: string, contentType: string, res: any) {
    const content = await readFile(file);
    res.set('Content-Type', contentType);
    res.send(content);
}
app.get('/', async (req: any, res: any) => {
    serveFile("dist/index.html", "text/html", res);
});
app.get('/index.js', async (req: any, res: any) => {
    serveFile("dist/index-rollup.js", "application/javascript", res);
});
app.post('/lobby/generate-room', async (req: any, res: any) => {
    console.error('generate-root', req);
    res.status(500).end()
});
