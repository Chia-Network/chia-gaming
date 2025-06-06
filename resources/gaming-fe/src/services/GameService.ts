import { v4 as uuidv4 } from 'uuid';
import { AppError, ErrorCodes } from '../types/errors';
import { GameType, GameSession, Player, Room } from '../types/lobby';
import { saveGameSession, getGameSession } from '../db';

export class GameService {
  private static instance: GameService;
  private activeSessions: Map<string, GameSession>;

  private constructor() {
    this.activeSessions = new Map();
  }

  public static getInstance(): GameService {
    if (!GameService.instance) {
      GameService.instance = new GameService();
    }
    return GameService.instance;
  }

  public async startGame(room: Room): Promise<GameSession> {
    if (room.status !== 'waiting') {
      throw new AppError(
        ErrorCodes.LOBBY.GAME_IN_PROGRESS,
        'Game is already in progress',
        400
      );
    }

    if (room.players.length < room.minPlayers) {
      throw new AppError(
        ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
        'Not enough players to start the game',
        400
      );
    }

    const session: GameSession = {
      id: uuidv4(),
      roomId: room.id,
      gameType: room.gameType,
      players: room.players,
      startedAt: Date.now(),
      status: 'in_progress',
      parameters: []
    };

    this.activeSessions.set(session.id, session);
    await saveGameSession(session);

    return session;
  }

  public async endGame(sessionId: string, winner: string): Promise<GameSession> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new AppError(
        ErrorCodes.LOBBY.GAME_IN_PROGRESS,
        'Game session not found',
        404
      );
    }

    session.status = 'completed';
    session.winner = winner;
    this.activeSessions.delete(sessionId);
    await saveGameSession(session);

    return session;
  }

  public async getSession(sessionId: string): Promise<GameSession> {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      return session;
    }

    const dbSession = await getGameSession(sessionId);
    if (!dbSession) {
      throw new AppError(
        ErrorCodes.LOBBY.GAME_IN_PROGRESS,
        'Game session not found',
        404
      );
    }

    return dbSession;
  }

  public async validateGameAction(
    sessionId: string,
    playerId: string,
    action: string,
    data: any
  ): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (session.status !== 'in_progress') {
      throw new AppError(
        ErrorCodes.LOBBY.GAME_IN_PROGRESS,
        'Game is not in progress',
        400
      );
    }

    const player = session.players.find(p => p.id === playerId);
    if (!player) {
      throw new AppError(
        ErrorCodes.LOBBY.PLAYER_NOT_FOUND,
        'Player not found in game session',
        404
      );
    }

    switch (session.gameType) {
      case 'california_poker':
        return this.validatePokerAction(action, data);
      case 'krunk':
        return this.validateKrunkAction(action, data);
      case 'exotic_poker':
        return this.validateExoticPokerAction(action, data);
      default:
        throw new AppError(
          ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
          'Invalid game type',
          400
        );
    }
  }

  private validatePokerAction(action: string, data: any): boolean {
    const validActions = ['fold', 'check', 'call', 'raise', 'all-in'];
    if (!validActions.includes(action)) {
      throw new AppError(
        ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
        'Invalid poker action',
        400
      );
    }

    if (action === 'raise' && (!data.amount || data.amount <= 0)) {
      throw new AppError(
        ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
        'Invalid raise amount',
        400
      );
    }

    return true;
  }

  private validateKrunkAction(action: string, data: any): boolean {
    const validActions = ['guess', 'hint', 'pass'];
    if (!validActions.includes(action)) {
      throw new AppError(
        ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
        'Invalid krunk action',
        400
      );
    }

    if (action === 'guess' && (!data.word || typeof data.word !== 'string')) {
      throw new AppError(
        ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
        'Invalid guess word',
        400
      );
    }

    return true;
  }

  private validateExoticPokerAction(action: string, data: any): boolean {
    const validActions = ['fold', 'check', 'call', 'raise', 'all-in', 'wild'];
    if (!validActions.includes(action)) {
      throw new AppError(
        ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
        'Invalid exotic poker action',
        400
      );
    }

    if (action === 'raise' && (!data.amount || data.amount <= 0)) {
      throw new AppError(
        ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
        'Invalid raise amount',
        400
      );
    }

    if (action === 'wild' && (!data.card || !data.target)) {
      throw new AppError(
        ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
        'Invalid wild card action',
        400
      );
    }

    return true;
  }

  public async processGameAction(
    sessionId: string,
    playerId: string,
    action: string,
    data: any
  ): Promise<void> {
    const isValid = await this.validateGameAction(sessionId, playerId, action, data);
    if (!isValid) {
      return;
    }

    const session = await this.getSession(sessionId);
    switch (session.gameType) {
      case 'california_poker':
        await this.processPokerAction(session, playerId, action, data);
        break;
      case 'krunk':
        await this.processKrunkAction(session, playerId, action, data);
        break;
      case 'exotic_poker':
        await this.processExoticPokerAction(session, playerId, action, data);
        break;
    }
  }

  private async processPokerAction(
    session: GameSession,
    playerId: string,
    action: string,
    data: any
  ): Promise<void> {
  }

  private async processKrunkAction(
    session: GameSession,
    playerId: string,
    action: string,
    data: any
  ): Promise<void> {
  }

  private async processExoticPokerAction(
    session: GameSession,
    playerId: string,
    action: string,
    data: any
  ): Promise<void> {
  }
} 
