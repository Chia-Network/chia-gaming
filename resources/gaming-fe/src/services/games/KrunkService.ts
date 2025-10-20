import { v4 as uuidv4 } from "uuid";
import { AppError, ErrorCodes } from "../../types/errors";
import { Player, GameSession } from "../../types/lobby";

interface Word {
  word: string;
  hint: string;
  difficulty: "easy" | "medium" | "hard";
  category: string;
}

interface PlayerState {
  playerId: string;
  score: number;
  hintsUsed: number;
  correctGuesses: number;
  wrongGuesses: number;
  lastGuess?: string;
  lastGuessTime?: Date;
}

interface GameState {
  id: string;
  sessionId: string;
  players: PlayerState[];
  currentWord?: Word;
  currentPlayerIndex: number;
  round: number;
  maxRounds: number;
  status: "waiting" | "in_progress" | "completed";
  startTime?: Date;
  endTime?: Date;
  lastAction?: {
    playerId: string;
    action: string;
    details?: any;
  };
}

export class KrunkService {
  private static instance: KrunkService;
  private gameStates: Map<string, GameState>;
  private readonly WORDS: Word[] = [];

  private constructor() {
    this.gameStates = new Map();
  }

  public static getInstance(): KrunkService {
    if (!KrunkService.instance) {
      KrunkService.instance = new KrunkService();
    }
    return KrunkService.instance;
  }

  public async startGame(session: GameSession): Promise<GameState> {
    const players = this.initializePlayers([session.host, session.joiner]);
    const gameState: GameState = {
      id: uuidv4(),
      sessionId: session.id,
      players,
      currentPlayerIndex: 0,
      round: 1,
      maxRounds: 10,
      status: "in_progress",
      startTime: new Date(),
    };

    this.gameStates.set(session.id, gameState);
    await this.startNewRound(gameState);
    return gameState;
  }

  private initializePlayers(players: string[]): PlayerState[] {
    return players.map((player) => ({
      playerId: player,
      score: 0,
      hintsUsed: 0,
      correctGuesses: 0,
      wrongGuesses: 0,
    }));
  }

  private async startNewRound(gameState: GameState): Promise<void> {
    if (gameState.round > gameState.maxRounds) {
      gameState.status = "completed";
      gameState.endTime = new Date();
      return;
    }

    let difficulty: Word["difficulty"];
    if (gameState.round <= 3) {
      difficulty = "easy";
    } else if (gameState.round <= 7) {
      difficulty = "medium";
    } else {
      difficulty = "hard";
    }

    const availableWords = this.WORDS.filter(
      (w) => w.difficulty === difficulty,
    );
    gameState.currentWord =
      availableWords[Math.floor(Math.random() * availableWords.length)];
    gameState.currentPlayerIndex = 0;
  }

  public async processAction(
    sessionId: string,
    playerId: string,
    action: string,
    data?: any,
  ): Promise<GameState> {
    const gameState = this.gameStates.get(sessionId);
    if (!gameState) {
      throw new AppError(
        ErrorCodes.LOBBY.GAME_IN_PROGRESS,
        "Game not found",
        404,
      );
    }

    if (gameState.status !== "in_progress") {
      throw new AppError(
        ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
        "Game is not in progress",
        400,
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

    switch (action) {
      case "guess":
        if (!data?.word) {
          throw new AppError(
            ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
            "Guess word required",
            400,
          );
        }
        await this.handleGuess(gameState, playerIndex, data.word);
        break;
      case "hint":
        await this.handleHint(gameState, playerIndex);
        break;
      case "pass":
        await this.handlePass(gameState, playerIndex);
        break;
      default:
        throw new AppError(
          ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
          "Invalid action",
          400,
        );
    }

    gameState.lastAction = { playerId, action, details: data };
    return gameState;
  }

  private async handleGuess(
    gameState: GameState,
    playerIndex: number,
    guess: string,
  ): Promise<void> {
    const player = gameState.players[playerIndex];
    const word = gameState.currentWord!;

    player.lastGuess = guess;
    player.lastGuessTime = new Date();

    if (guess.toLowerCase() === word.word.toLowerCase()) {
      player.score += this.calculateScore(word.difficulty, player.hintsUsed);
      player.correctGuesses++;
      gameState.round++;
      await this.startNewRound(gameState);
    } else {
      player.wrongGuesses++;
      this.moveToNextPlayer(gameState);
    }
  }

  private async handleHint(
    gameState: GameState,
    playerIndex: number,
  ): Promise<void> {
    const player = gameState.players[playerIndex];
    player.hintsUsed++;
  }

  private async handlePass(
    gameState: GameState,
    playerIndex: number,
  ): Promise<void> {
    this.moveToNextPlayer(gameState);
  }

  private moveToNextPlayer(gameState: GameState): void {
    gameState.currentPlayerIndex =
      (gameState.currentPlayerIndex + 1) % gameState.players.length;
  }

  private calculateScore(
    difficulty: Word["difficulty"],
    hintsUsed: number,
  ): number {
    let baseScore: number;
    switch (difficulty) {
      case "easy":
        baseScore = 100;
        break;
      case "medium":
        baseScore = 200;
        break;
      case "hard":
        baseScore = 300;
        break;
    }

    const hintPenalty = hintsUsed * 20;
    return Math.max(baseScore - hintPenalty, 0);
  }

  public getGameState(sessionId: string): GameState | undefined {
    return this.gameStates.get(sessionId);
  }

  public endGame(sessionId: string): void {
    const gameState = this.gameStates.get(sessionId);
    if (gameState) {
      gameState.status = "completed";
      gameState.endTime = new Date();
    }
    this.gameStates.delete(sessionId);
  }

  public getLeaderboard(sessionId: string): PlayerState[] {
    const gameState = this.gameStates.get(sessionId);
    if (!gameState) {
      throw new AppError(
        ErrorCodes.LOBBY.GAME_IN_PROGRESS,
        "Game not found",
        404,
      );
    }

    return [...gameState.players].sort((a, b) => b.score - a.score);
  }
}
