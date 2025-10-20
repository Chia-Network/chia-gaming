import { v4 as uuidv4 } from "uuid";
import { AppError, ErrorCodes } from "../../types/errors";
import { Player, GameSession } from "../../types/lobby";

interface Card {
  suit: "hearts" | "diamonds" | "clubs" | "spades";
  rank:
    | "2"
    | "3"
    | "4"
    | "5"
    | "6"
    | "7"
    | "8"
    | "9"
    | "10"
    | "J"
    | "Q"
    | "K"
    | "A";
}

interface PlayerHand {
  playerId: string;
  cards: Card[];
  bet: number;
  status: "active" | "folded" | "all-in";
  lastAction?: string;
}

interface GameState {
  id: string;
  sessionId: string;
  players: PlayerHand[];
  communityCards: Card[];
  pot: number;
  currentBet: number;
  dealerIndex: number;
  currentPlayerIndex: number;
  phase: string;
  deck: Card[];
  lastAction?: {
    playerId: string;
    action: string;
    amount?: number;
  };
}

export class CaliforniaPokerService {
  private static instance: CaliforniaPokerService;
  private gameStates: Map<string, GameState>;
  private readonly SUITS: Card["suit"][] = [
    "hearts",
    "diamonds",
    "clubs",
    "spades",
  ];
  private readonly RANKS: Card["rank"][] = [
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
  private readonly SMALL_BLIND = 5;
  private readonly BIG_BLIND = 10;

  private constructor() {
    this.gameStates = new Map();
  }

  public static getInstance(): CaliforniaPokerService {
    if (!CaliforniaPokerService.instance) {
      CaliforniaPokerService.instance = new CaliforniaPokerService();
    }
    return CaliforniaPokerService.instance;
  }

  public async startGame(session: GameSession): Promise<GameState> {
    const deck = this.createDeck();
    const shuffledDeck = this.shuffleDeck(deck);
    const players = this.initializePlayers(
      [session.host, session.joiner],
      shuffledDeck,
    );

    const gameState: GameState = {
      id: uuidv4(),
      sessionId: session.id,
      players,
      communityCards: [],
      pot: 0,
      currentBet: this.BIG_BLIND,
      dealerIndex: 0,
      currentPlayerIndex: 2,
      phase: "pre-flop",
      deck: shuffledDeck.slice(players.length * 2 + 3),
      lastAction: undefined,
    };

    this.postBlinds(gameState);

    this.gameStates.set(session.id, gameState);
    return gameState;
  }

  private createDeck(): Card[] {
    const deck: Card[] = [];
    for (const suit of this.SUITS) {
      for (const rank of this.RANKS) {
        deck.push({ suit, rank });
      }
    }
    return deck;
  }

  private shuffleDeck(deck: Card[]): Card[] {
    const shuffled = [...deck];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  private initializePlayers(players: string[], deck: Card[]): PlayerHand[] {
    return players.map((player, index) => ({
      playerId: player,
      cards: [deck[index * 2], deck[index * 2 + 1]],
      bet: 0,
      status: "active",
    }));
  }

  private postBlinds(gameState: GameState): void {
    const { players, dealerIndex } = gameState;
    const smallBlindIndex = (dealerIndex + 1) % players.length;
    const bigBlindIndex = (dealerIndex + 2) % players.length;

    players[smallBlindIndex].bet = this.SMALL_BLIND;
    players[bigBlindIndex].bet = this.BIG_BLIND;
    gameState.pot = this.SMALL_BLIND + this.BIG_BLIND;
  }

  public async processAction(
    sessionId: string,
    playerId: string,
    action: string,
    amount?: number,
  ): Promise<GameState> {
    const gameState = this.gameStates.get(sessionId);
    if (!gameState) {
      throw new AppError(
        ErrorCodes.LOBBY.GAME_IN_PROGRESS,
        "Game not found",
        404,
      );
    }

    const playerIndex = gameState.players.findIndex(
      (p) => p.playerId === playerId,
    );
    if (playerIndex === -1) {
      throw new AppError(
        ErrorCodes.LOBBY.PLAYER_NOT_FOUND,
        "Player not in game",
        404,
      );
    }

    if (playerIndex !== gameState.currentPlayerIndex) {
      throw new AppError(
        ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
        "Not your turn",
        400,
      );
    }

    const player = gameState.players[playerIndex];
    if (player.status !== "active") {
      throw new AppError(
        ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
        "Player is not active",
        400,
      );
    }

    switch (action) {
      case "fold":
        this.handleFold(gameState, playerIndex);
        break;
      case "check":
        this.handleCheck(gameState, playerIndex);
        break;
      case "call":
        this.handleCall(gameState, playerIndex);
        break;
      case "raise":
        if (!amount) {
          throw new AppError(
            ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
            "Raise amount required",
            400,
          );
        }
        this.handleRaise(gameState, playerIndex, amount);
        break;
      case "all-in":
        this.handleAllIn(gameState, playerIndex);
        break;
      default:
        throw new AppError(
          ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
          "Invalid action",
          400,
        );
    }

    gameState.lastAction = { playerId, action, amount };
    this.moveToNextPlayer(gameState);
    this.checkPhaseEnd(gameState);

    return gameState;
  }

  private handleFold(gameState: GameState, playerIndex: number): void {
    gameState.players[playerIndex].status = "folded";
  }

  private handleCheck(gameState: GameState, playerIndex: number): void {
    if (gameState.currentBet > gameState.players[playerIndex].bet) {
      throw new AppError(
        ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
        "Cannot check when there is a bet",
        400,
      );
    }
  }

  private handleCall(gameState: GameState, playerIndex: number): void {
    const player = gameState.players[playerIndex];
    const callAmount = gameState.currentBet - player.bet;
    player.bet = gameState.currentBet;
    gameState.pot += callAmount;
  }

  private handleRaise(
    gameState: GameState,
    playerIndex: number,
    amount: number,
  ): void {
    const player = gameState.players[playerIndex];
    const totalBet = player.bet + amount;

    if (totalBet <= gameState.currentBet) {
      throw new AppError(
        ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
        "Raise must be higher than current bet",
        400,
      );
    }

    player.bet = totalBet;
    gameState.currentBet = totalBet;
    gameState.pot += amount;
  }

  private handleAllIn(gameState: GameState, playerIndex: number): void {
    const player = gameState.players[playerIndex];
    player.status = "all-in";
    player.bet = gameState.currentBet;
    gameState.pot += gameState.currentBet;
  }

  private moveToNextPlayer(gameState: GameState): void {
    do {
      gameState.currentPlayerIndex =
        (gameState.currentPlayerIndex + 1) % gameState.players.length;
    } while (
      gameState.players[gameState.currentPlayerIndex].status !== "active"
    );
  }

  private checkPhaseEnd(gameState: GameState): void {
    const activePlayers = gameState.players.filter(
      (p) => p.status === "active",
    );
    const allBetsEqual = activePlayers.every(
      (p) => p.bet === gameState.currentBet,
    );
    const lastPlayerIndex =
      (gameState.dealerIndex + 2) % gameState.players.length;

    if (allBetsEqual && gameState.currentPlayerIndex === lastPlayerIndex) {
      this.advancePhase(gameState);
    }
  }

  private advancePhase(gameState: GameState): void {
    switch (gameState.phase) {
      case "pre-flop":
        gameState.phase = "flop";
        this.dealCommunityCards(gameState, 3);
        break;
      case "flop":
        gameState.phase = "turn";
        this.dealCommunityCards(gameState, 1);
        break;
      case "turn":
        gameState.phase = "river";
        this.dealCommunityCards(gameState, 1);
        break;
      case "river":
        gameState.phase = "showdown";
        this.determineWinner(gameState);
        break;
    }

    if (gameState.phase !== "showdown") {
      gameState.currentBet = 0;
      gameState.players.forEach((p) => (p.bet = 0));
      gameState.currentPlayerIndex =
        (gameState.dealerIndex + 1) % gameState.players.length;
    }
  }

  private dealCommunityCards(gameState: GameState, count: number): void {
    for (let i = 0; i < count; i++) {
      gameState.communityCards.push(gameState.deck.pop()!);
    }
  }

  private determineWinner(gameState: GameState): void {
    const activePlayers = gameState.players.filter(
      (p) => p.status !== "folded",
    );
    if (activePlayers.length === 1) {
      return;
    }
  }

  public getGameState(sessionId: string): GameState | undefined {
    return this.gameStates.get(sessionId);
  }

  public endGame(sessionId: string): void {
    this.gameStates.delete(sessionId);
  }
}
