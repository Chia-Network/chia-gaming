import { v4 as uuidv4 } from 'uuid';
import { AppError, ErrorCodes } from '../types/errors';
import { GameType } from '../types/lobby';

interface GameStats {
  totalGames: number;
  wins: number;
  losses: number;
  totalWinnings: number;
  totalLosses: number;
  averagePotSize: number;
  biggestWin: number;
  biggestLoss: number;
  winRate: number;
  averageGameDuration: number;
}

interface PlayerStats {
  playerId: string;
  gameType: GameType;
  stats: GameStats;
  lastUpdated: Date;
}

interface GameSession {
  sessionId: string;
  gameType: GameType;
  startTime: Date;
  endTime?: Date;
  players: {
    playerId: string;
    startingStack: number;
    endingStack?: number;
    actions: GameAction[];
  }[];
  potSize: number;
  winner?: string;
}

interface GameAction {
  playerId: string;
  action: 'fold' | 'check' | 'call' | 'raise' | 'all-in';
  amount?: number;
  timestamp: Date;
}

export class GameAnalyticsService {
  private static instance: GameAnalyticsService;
  private playerStats: Map<string, PlayerStats>;
  private gameSessions: Map<string, GameSession>;
  private readonly statsRetentionDays: number = 30;

  private constructor() {
    this.playerStats = new Map();
    this.gameSessions = new Map();
  }

  public static getInstance(): GameAnalyticsService {
    if (!GameAnalyticsService.instance) {
      GameAnalyticsService.instance = new GameAnalyticsService();
    }
    return GameAnalyticsService.instance;
  }

  public startGameSession(gameType: GameType, players: { playerId: string; startingStack: number }[]): string {
    const sessionId = uuidv4();
    const session: GameSession = {
      sessionId,
      gameType,
      startTime: new Date(),
      players: players.map((p) => ({
        ...p,
        actions: [],
      })),
      potSize: 0,
    };

    this.gameSessions.set(sessionId, session);
    return sessionId;
  }

  public recordAction(sessionId: string, playerId: string, action: GameAction['action'], amount?: number): void {
    const session = this.gameSessions.get(sessionId);
    if (!session) {
      throw new AppError(ErrorCodes.GAME.SESSION_NOT_FOUND, 'Game session not found', 404);
    }

    const player = session.players.find((p) => p.playerId === playerId);
    if (!player) {
      throw new AppError(ErrorCodes.GAME.PLAYER_NOT_IN_SESSION, 'Player not found in game session', 404);
    }

    player.actions.push({
      playerId,
      action,
      amount,
      timestamp: new Date(),
    });

    if (amount) {
      session.potSize += amount;
    }
  }

  public endGameSession(sessionId: string, winner: string, finalStacks: { playerId: string; stack: number }[]): void {
    const session = this.gameSessions.get(sessionId);
    if (!session) {
      throw new AppError(ErrorCodes.GAME.SESSION_NOT_FOUND, 'Game session not found', 404);
    }

    session.endTime = new Date();
    session.winner = winner;

    for (const player of session.players) {
      const finalStack = finalStacks.find((s) => s.playerId === player.playerId);
      if (finalStack) {
        player.endingStack = finalStack.stack;
        this.updatePlayerStats(player.playerId, session.gameType, {
          startingStack: player.startingStack,
          endingStack: finalStack.stack,
          sessionDuration: session.endTime.getTime() - session.startTime.getTime(),
        });
      }
    }
  }

  private updatePlayerStats(
    playerId: string,
    gameType: GameType,
    gameResult: {
      startingStack: number;
      endingStack: number;
      sessionDuration: number;
    },
  ): void {
    const key = `${playerId}-${gameType}`;
    let stats = this.playerStats.get(key);

    if (!stats) {
      stats = {
        playerId,
        gameType,
        stats: {
          totalGames: 0,
          wins: 0,
          losses: 0,
          totalWinnings: 0,
          totalLosses: 0,
          averagePotSize: 0,
          biggestWin: 0,
          biggestLoss: 0,
          winRate: 0,
          averageGameDuration: 0,
        },
        lastUpdated: new Date(),
      };
    }

    const profit = gameResult.endingStack - gameResult.startingStack;
    const isWin = profit > 0;

    stats.stats.totalGames++;
    if (isWin) {
      stats.stats.wins++;
      stats.stats.totalWinnings += profit;
      stats.stats.biggestWin = Math.max(stats.stats.biggestWin, profit);
    } else {
      stats.stats.losses++;
      stats.stats.totalLosses += Math.abs(profit);
      stats.stats.biggestLoss = Math.max(stats.stats.biggestLoss, Math.abs(profit));
    }

    stats.stats.winRate = (stats.stats.wins / stats.stats.totalGames) * 100;
    stats.stats.averageGameDuration =
      (stats.stats.averageGameDuration * (stats.stats.totalGames - 1) + gameResult.sessionDuration) /
      stats.stats.totalGames;

    stats.lastUpdated = new Date();
    this.playerStats.set(key, stats);
  }

  public getPlayerStats(playerId: string, gameType: GameType): GameStats | null {
    const key = `${playerId}-${gameType}`;
    const stats = this.playerStats.get(key);
    return stats ? stats.stats : null;
  }

  public getGameSession(sessionId: string): GameSession | null {
    return this.gameSessions.get(sessionId) || null;
  }

  public getPlayerGameHistory(playerId: string, gameType: GameType, limit: number = 10): GameSession[] {
    return Array.from(this.gameSessions.values())
      .filter((session) => session.gameType === gameType && session.players.some((p) => p.playerId === playerId))
      .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
      .slice(0, limit);
  }

  public getTopPlayers(gameType: GameType, limit: number = 10): { playerId: string; stats: GameStats }[] {
    return Array.from(this.playerStats.values())
      .filter((stats) => stats.gameType === gameType)
      .sort((a, b) => b.stats.winRate - a.stats.winRate)
      .slice(0, limit)
      .map((stats) => ({
        playerId: stats.playerId,
        stats: stats.stats,
      }));
  }

  public getGameTypeStats(gameType: GameType): {
    totalGames: number;
    averagePotSize: number;
    averageGameDuration: number;
    mostCommonAction: string;
  } {
    const sessions = Array.from(this.gameSessions.values()).filter((session) => session.gameType === gameType);

    const totalGames = sessions.length;
    const averagePotSize = sessions.reduce((sum, session) => sum + session.potSize, 0) / totalGames;
    const averageGameDuration =
      sessions.reduce((sum, session) => {
        if (session.endTime) {
          return sum + (session.endTime.getTime() - session.startTime.getTime());
        }
        return sum;
      }, 0) / totalGames;

    const actionCounts = new Map<string, number>();
    sessions.forEach((session) => {
      session.players.forEach((player) => {
        player.actions.forEach((action) => {
          const count = actionCounts.get(action.action) || 0;
          actionCounts.set(action.action, count + 1);
        });
      });
    });

    let mostCommonAction = '';
    let maxCount = 0;
    actionCounts.forEach((count, action) => {
      if (count > maxCount) {
        maxCount = count;
        mostCommonAction = action;
      }
    });

    return {
      totalGames,
      averagePotSize,
      averageGameDuration,
      mostCommonAction,
    };
  }

  public cleanupOldData(): void {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.statsRetentionDays);

    for (const [sessionId, session] of this.gameSessions.entries()) {
      if (session.startTime < cutoffDate) {
        this.gameSessions.delete(sessionId);
      }
    }

    for (const [key, stats] of this.playerStats.entries()) {
      if (stats.lastUpdated < cutoffDate) {
        this.playerStats.delete(key);
      }
    }
  }
}
