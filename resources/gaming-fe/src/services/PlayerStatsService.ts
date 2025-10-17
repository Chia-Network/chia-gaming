import { v4 as uuidv4 } from 'uuid';

import { getPlayer } from '../db';
import { AppError, ErrorCodes } from '../types/errors';
import { GameType } from '../types/lobby';

interface PlayerStats {
  id: string;
  playerId: string;
  gameType: GameType;
  gamesPlayed: number;
  gamesWon: number;
  totalWinnings: number;
  highestWin: number;
  winStreak: number;
  currentStreak: number;
  lastPlayed: Date;
}

interface Achievement {
  id: string;
  playerId: string;
  name: string;
  description: string;
  unlockedAt: Date;
  gameType: GameType;
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
}

export class PlayerStatsService {
  private static instance: PlayerStatsService;
  private playerStats: Map<string, PlayerStats>;
  private achievements: Map<string, Achievement[]>;

  private constructor() {
    this.playerStats = new Map();
    this.achievements = new Map();
  }

  public static getInstance(): PlayerStatsService {
    if (!PlayerStatsService.instance) {
      PlayerStatsService.instance = new PlayerStatsService();
    }
    return PlayerStatsService.instance;
  }

  public async getPlayerStats(playerId: string, gameType: GameType): Promise<PlayerStats> {
    const key = `${playerId}-${gameType}`;
    let stats = this.playerStats.get(key);

    if (!stats) {
      const player = await getPlayer(playerId);
      if (!player) {
        throw new AppError(ErrorCodes.LOBBY.PLAYER_NOT_FOUND, 'Player not found', 404);
      }

      stats = {
        id: uuidv4(),
        playerId,
        gameType,
        gamesPlayed: 0,
        gamesWon: 0,
        totalWinnings: 0,
        highestWin: 0,
        winStreak: 0,
        currentStreak: 0,
        lastPlayed: new Date(),
      };

      this.playerStats.set(key, stats);
    }

    return stats;
  }

  public async updatePlayerStats(
    playerId: string,
    gameType: GameType,
    won: boolean,
    winnings: number,
  ): Promise<PlayerStats> {
    const stats = await this.getPlayerStats(playerId, gameType);

    stats.gamesPlayed++;
    if (won) {
      stats.gamesWon++;
      stats.totalWinnings += winnings;
      stats.highestWin = Math.max(stats.highestWin, winnings);
      stats.currentStreak++;
      stats.winStreak = Math.max(stats.winStreak, stats.currentStreak);
    } else {
      stats.currentStreak = 0;
    }

    stats.lastPlayed = new Date();
    this.playerStats.set(`${playerId}-${gameType}`, stats);

    await this.checkAchievements(playerId, gameType, stats);
    return stats;
  }

  public async getPlayerAchievements(playerId: string): Promise<Achievement[]> {
    let achievements = this.achievements.get(playerId);
    if (!achievements) {
      achievements = [];
      this.achievements.set(playerId, achievements);
    }
    return achievements;
  }

  private async checkAchievements(playerId: string, gameType: GameType, stats: PlayerStats): Promise<void> {
    const achievements = await this.getPlayerAchievements(playerId);
    const newAchievements: Achievement[] = [];

    if (stats.gamesPlayed === 1) {
      newAchievements.push(
        this.createAchievement(playerId, 'First Game', 'Played your first game', gameType, 'common'),
      );
    }

    if (stats.gamesWon === 1) {
      newAchievements.push(
        this.createAchievement(playerId, 'First Victory', 'Won your first game', gameType, 'common'),
      );
    }

    if (stats.winStreak >= 3) {
      newAchievements.push(
        this.createAchievement(playerId, 'Hot Streak', 'Won 3 games in a row', gameType, 'uncommon'),
      );
    }

    if (stats.winStreak >= 5) {
      newAchievements.push(this.createAchievement(playerId, 'Unstoppable', 'Won 5 games in a row', gameType, 'rare'));
    }

    if (stats.totalWinnings >= 1000) {
      newAchievements.push(
        this.createAchievement(playerId, 'High Roller', 'Won 1000 or more in total', gameType, 'epic'),
      );
    }

    if (stats.highestWin >= 500) {
      newAchievements.push(
        this.createAchievement(playerId, 'Big Winner', 'Won 500 or more in a single game', gameType, 'legendary'),
      );
    }

    for (const achievement of newAchievements) {
      if (!achievements.some((a) => a.name === achievement.name)) {
        achievements.push(achievement);
      }
    }

    this.achievements.set(playerId, achievements);
  }

  private createAchievement(
    playerId: string,
    name: string,
    description: string,
    gameType: GameType,
    rarity: Achievement['rarity'],
  ): Achievement {
    return {
      id: uuidv4(),
      playerId,
      name,
      description,
      unlockedAt: new Date(),
      gameType,
      rarity,
    };
  }

  public async getLeaderboard(gameType: GameType, limit = 10): Promise<PlayerStats[]> {
    const stats = Array.from(this.playerStats.values())
      .filter((s) => s.gameType === gameType)
      .sort((a, b) => {
        const aWinRate = a.gamesPlayed > 0 ? a.gamesWon / a.gamesPlayed : 0;
        const bWinRate = b.gamesPlayed > 0 ? b.gamesWon / b.gamesPlayed : 0;

        if (b.totalWinnings !== a.totalWinnings) {
          return b.totalWinnings - a.totalWinnings;
        }
        return bWinRate - aWinRate;
      })
      .slice(0, limit);

    return stats;
  }

  public async getPlayerRank(playerId: string, gameType: GameType): Promise<number> {
    const allStats = Array.from(this.playerStats.values())
      .filter((s) => s.gameType === gameType)
      .sort((a, b) => b.totalWinnings - a.totalWinnings);

    const rank = allStats.findIndex((s) => s.playerId === playerId) + 1;

    return rank || allStats.length + 1;
  }
}
