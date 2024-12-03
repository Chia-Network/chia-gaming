const express = require("express");
const http = require("http");
const socketIo = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

let waitingPlayer = null;

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  socket.on("findOpponent", (data) => {
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

  socket.on("action", (data) => {
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

const shuffleDeck = (deck) => {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
};

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
