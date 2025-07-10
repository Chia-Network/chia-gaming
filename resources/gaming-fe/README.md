# Cal Poker Game

## **Introduction**

Cal Poker is a simple real-time poker game where two players can connect, place wagers, and play turns against each other. The game uses Socket.IO for real-time communication between clients and the server.

## **Features**

- Real-time multiplayer gameplay
- Simple betting system
- Turn-based actions
- Interactive UI with Material-UI components
- Modular and maintainable codebase

## **Prerequisites**

- **Node.js**
- **npm**
- **TypeScript**

## **Setup**

1. **Install dependencies for the client:**
   ```npm install```

2. **Starting the lobby service:**
   ```node ./dist/lobby.js```

3. **Start the React application:**
   ```npm start```

The client will start on port 3000 by default and should open automatically in your default browser.

## **Usage**
Open two browser windows or tabs:

Go to http://localhost:3000 in both.
Enter a wager amount and find an opponent:

In both windows, enter a wager amount (e.g., 50) and click "Find an opponent".
