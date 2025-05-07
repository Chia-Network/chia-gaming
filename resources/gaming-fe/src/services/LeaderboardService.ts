import { AppError, ErrorCodes } from '../types/errors';
import { GameType } from '../types/lobby';

interface LeaderboardEntry {
  playerId: string;
  playerName: string;
  score: number;
  rank: number;
  stats: {
    gamesPlayed: number;
    gamesWon: number;
    winRate: number;
    totalWinnings: number;
    biggestWin: number;
  };
}

interface Leaderboard {
  id: string;
  type: 'global' | 'game' | 'achievement';
  gameType?: GameType;
  timeFrame: 'daily' | 'weekly' | 'monthly' | 'all-time';
  entries: LeaderboardEntry[];
  lastUpdated: Date;
}

export class LeaderboardService {
  private static instance: LeaderboardService;
  private leaderboards: Map<string, Leaderboard>;
  private readonly updateInterval: number = 5 * 60 * 1000;
  private lastUpdate: Date;

  private constructor() {
    this.leaderboards = new Map();
    this.lastUpdate = new Date();
    this.initializeLeaderboards();
  }

  private initializeLeaderboards(): void {
    this.createLeaderboard('global', 'global', 'all-time');
    this.createLeaderboard('global', 'global', 'monthly');
    this.createLeaderboard('global', 'global', 'weekly');
    this.createLeaderboard('global', 'global', 'daily');

    const gameTypes: GameType[] = ['california_poker', 'krunk', 'exotic_poker'];
    const timeFrames: Leaderboard['timeFrame'][] = ['all-time', 'monthly', 'weekly', 'daily'];

    for (const gameType of gameTypes) {
      for (const timeFrame of timeFrames) {
        this.createLeaderboard('game', gameType, timeFrame);
      }
    }

    this.createLeaderboard('achievement', undefined, 'all-time');
  }

  public static getInstance(): LeaderboardService {
    if (!LeaderboardService.instance) {
      LeaderboardService.instance = new LeaderboardService();
    }
    return LeaderboardService.instance;
  }

  private createLeaderboard(
    type: Leaderboard['type'],
    gameType: GameType | 'global' | undefined,
    timeFrame: Leaderboard['timeFrame']
  ): void {
    const id = `${type}-${gameType || 'global'}-${timeFrame}`;
    const leaderboard: Leaderboard = {
      id,
      type,
      gameType: gameType === 'global' ? undefined : gameType,
      timeFrame,
      entries: [],
      lastUpdated: new Date()
    };
    this.leaderboards.set(id, leaderboard);
  }

  public getLeaderboard(
    type: Leaderboard['type'],
    gameType?: GameType,
    timeFrame: Leaderboard['timeFrame'] = 'all-time'
  ): Leaderboard {
    const id = `${type}-${gameType || 'global'}-${timeFrame}`;
    const leaderboard = this.leaderboards.get(id);
    if (!leaderboard) {
      throw new AppError(ErrorCodes.SYSTEM.NOT_FOUND, 'Leaderboard not found', 404);
    }

    if (this.shouldUpdateLeaderboard(leaderboard)) {
      this.updateLeaderboard(leaderboard);
    }

    return leaderboard;
  }

  private shouldUpdateLeaderboard(leaderboard: Leaderboard): boolean {
    const now = new Date();
    const timeSinceLastUpdate = now.getTime() - leaderboard.lastUpdated.getTime();
    return timeSinceLastUpdate >= this.updateInterval;
  }

  private updateLeaderboard(leaderboard: Leaderboard): void {
    let entries: LeaderboardEntry[] = [];

    switch (leaderboard.type) {
      case 'global':
        entries = this.getGlobalLeaderboardEntries(leaderboard.timeFrame);
        break;
      case 'game':
        if (leaderboard.gameType) {
          entries = this.getGameLeaderboardEntries(leaderboard.gameType, leaderboard.timeFrame);
        }
        break;
      case 'achievement':
        entries = this.getAchievementLeaderboardEntries();
        break;
    }

    entries.sort((a, b) => b.score - a.score);
    entries.forEach((entry, index) => {
      entry.rank = index + 1;
    });

    leaderboard.entries = entries;
    leaderboard.lastUpdated = new Date();
  }

  private getGlobalLeaderboardEntries(timeFrame: Leaderboard['timeFrame']): LeaderboardEntry[] {
    return [];
  }

  private getGameLeaderboardEntries(
    gameType: GameType,
    timeFrame: Leaderboard['timeFrame']
  ): LeaderboardEntry[] {
    return [];
  }

  private getAchievementLeaderboardEntries(): LeaderboardEntry[] {
    return [];
  }

  public getPlayerRank(
    playerId: string,
    type: Leaderboard['type'],
    gameType?: GameType,
    timeFrame: Leaderboard['timeFrame'] = 'all-time'
  ): number {
    const leaderboard = this.getLeaderboard(type, gameType, timeFrame);
    const entry = leaderboard.entries.find(e => e.playerId === playerId);
    return entry ? entry.rank : -1;
  }

  public getTopPlayers(
    type: Leaderboard['type'],
    gameType?: GameType,
    timeFrame: Leaderboard['timeFrame'] = 'all-time',
    limit: number = 10
  ): LeaderboardEntry[] {
    const leaderboard = this.getLeaderboard(type, gameType, timeFrame);
    return leaderboard.entries.slice(0, limit);
  }

  public getPlayerStats(
    playerId: string,
    type: Leaderboard['type'],
    gameType?: GameType,
    timeFrame: Leaderboard['timeFrame'] = 'all-time'
  ): LeaderboardEntry | null {
    const leaderboard = this.getLeaderboard(type, gameType, timeFrame);
    return leaderboard.entries.find(e => e.playerId === playerId) || null;
  }

  public updatePlayerScore(
    playerId: string,
    playerName: string,
    score: number,
    stats: LeaderboardEntry['stats'],
    type: Leaderboard['type'],
    gameType?: GameType
  ): void {
    const timeFrames: Leaderboard['timeFrame'][] = ['daily', 'weekly', 'monthly', 'all-time'];

    for (const timeFrame of timeFrames) {
      const leaderboard = this.getLeaderboard(type, gameType, timeFrame);
      const entry = leaderboard.entries.find(e => e.playerId === playerId);

      if (entry) {
        entry.score = score;
        entry.stats = stats;
      } else {
        leaderboard.entries.push({
          playerId,
          playerName,
          score,
          rank: 0,
          stats
        });
      }

      leaderboard.entries.sort((a, b) => b.score - a.score);
      leaderboard.entries.forEach((entry, index) => {
        entry.rank = index + 1;
      });

      leaderboard.lastUpdated = new Date();
    }
  }

  public cleanupOldData(): void {
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    for (const [id, leaderboard] of this.leaderboards.entries()) {
      if (leaderboard.lastUpdated < cutoffDate) {
        this.leaderboards.delete(id);
      }
    }
  }
} 