import { v4 as uuidv4 } from 'uuid';

import { AppError, ErrorCodes } from '../types/errors';
import { GameType } from '../types/lobby';

interface Achievement {
  id: string;
  name: string;
  description: string;
  type: 'game' | 'social' | 'special';
  gameType?: GameType;
  points: number;
  requirements: {
    type:
      | 'games_played'
      | 'games_won'
      | 'win_streak'
      | 'total_winnings'
      | 'special';
    value: number;
  };
  icon: string;
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
}

interface PlayerAchievement {
  achievementId: string;
  playerId: string;
  unlockedAt: Date;
  progress: number;
  completed: boolean;
}

export class AchievementService {
  private static instance: AchievementService;
  private achievements: Map<string, Achievement>;
  private playerAchievements: Map<string, PlayerAchievement[]>;
  private readonly defaultAchievements: Achievement[] = [];

  private constructor() {
    this.achievements = new Map();
    this.playerAchievements = new Map();
    this.initializeAchievements();
  }

  private initializeAchievements(): void {
    this.defaultAchievements.forEach((achievement) => {
      this.achievements.set(achievement.id, achievement);
    });
  }

  public static getInstance(): AchievementService {
    if (!AchievementService.instance) {
      AchievementService.instance = new AchievementService();
    }
    return AchievementService.instance;
  }

  public createAchievement(achievement: Omit<Achievement, 'id'>): string {
    const id = uuidv4();
    const newAchievement: Achievement = {
      ...achievement,
      id,
    };
    this.achievements.set(id, newAchievement);
    return id;
  }

  public getAchievement(achievementId: string): Achievement {
    const achievement = this.achievements.get(achievementId);
    if (!achievement) {
      throw new AppError(
        ErrorCodes.SYSTEM.NOT_FOUND,
        'Achievement not found',
        404,
      );
    }
    return achievement;
  }

  public getAllAchievements(): Achievement[] {
    return Array.from(this.achievements.values());
  }

  public getAchievementsByType(type: Achievement['type']): Achievement[] {
    return Array.from(this.achievements.values()).filter(
      (achievement) => achievement.type === type,
    );
  }

  public getAchievementsByGameType(gameType: GameType): Achievement[] {
    return Array.from(this.achievements.values()).filter(
      (achievement) => achievement.gameType === gameType,
    );
  }

  public getPlayerAchievements(playerId: string): PlayerAchievement[] {
    return this.playerAchievements.get(playerId) || [];
  }

  public getPlayerCompletedAchievements(playerId: string): PlayerAchievement[] {
    return this.getPlayerAchievements(playerId).filter(
      (achievement) => achievement.completed,
    );
  }

  public getPlayerAchievementProgress(
    playerId: string,
    achievementId: string,
  ): number {
    const achievement = this.getPlayerAchievements(playerId).find(
      (a) => a.achievementId === achievementId,
    );
    return achievement ? achievement.progress : 0;
  }

  public updateAchievementProgress(
    playerId: string,
    achievementId: string,
    progress: number,
  ): void {
    const achievement = this.getAchievement(achievementId);
    let playerAchievement = this.getPlayerAchievements(playerId).find(
      (a) => a.achievementId === achievementId,
    );

    if (!playerAchievement) {
      playerAchievement = {
        achievementId,
        playerId,
        unlockedAt: new Date(),
        progress: 0,
        completed: false,
      };
      if (!this.playerAchievements.has(playerId)) {
        this.playerAchievements.set(playerId, []);
      }
      this.playerAchievements.get(playerId)!.push(playerAchievement);
    }

    playerAchievement.progress = progress;
    playerAchievement.completed = progress >= achievement.requirements.value;
  }

  public checkAndUpdateAchievements(
    playerId: string,
    stats: {
      gamesPlayed: number;
      gamesWon: number;
      currentWinStreak: number;
      totalWinnings: number;
      uniqueOpponents: number;
    },
  ): string[] {
    const unlockedAchievements: string[] = [];

    for (const achievement of this.achievements.values()) {
      let progress = 0;
      let shouldUpdate = false;

      switch (achievement.requirements.type) {
        case 'games_played':
          progress = stats.gamesPlayed;
          shouldUpdate = true;
          break;
        case 'games_won':
          progress = stats.gamesWon;
          shouldUpdate = true;
          break;
        case 'win_streak':
          progress = stats.currentWinStreak;
          shouldUpdate = true;
          break;
        case 'total_winnings':
          progress = stats.totalWinnings;
          shouldUpdate = true;
          break;
        case 'special':
          if (achievement.id === 'social_butterfly') {
            progress = stats.uniqueOpponents;
            shouldUpdate = true;
          }
          break;
      }

      if (shouldUpdate) {
        const currentProgress = this.getPlayerAchievementProgress(
          playerId,
          achievement.id,
        );
        if (progress > currentProgress) {
          this.updateAchievementProgress(playerId, achievement.id, progress);
          if (progress >= achievement.requirements.value) {
            unlockedAchievements.push(achievement.id);
          }
        }
      }
    }

    return unlockedAchievements;
  }

  public getTotalPoints(playerId: string): number {
    return this.getPlayerCompletedAchievements(playerId).reduce(
      (total, achievement) => {
        const achievementData = this.getAchievement(achievement.achievementId);
        return total + achievementData.points;
      },
      0,
    );
  }

  public getPlayerRank(playerId: string): number {
    const allPlayers = Array.from(this.playerAchievements.keys());
    const playerPoints = this.getTotalPoints(playerId);

    return (
      allPlayers
        .map((p) => this.getTotalPoints(p))
        .sort((a, b) => b - a)
        .indexOf(playerPoints) + 1
    );
  }
}
