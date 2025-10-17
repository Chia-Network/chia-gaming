import { AppError, ErrorCodes } from '../types/errors';
import { GameType } from '../types/lobby';

interface GameConfig {
  id: string;
  gameType: GameType;
  name: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  startingStack: number;
  blinds: {
    small: number;
    big: number;
  };
  timeLimits: {
    action: number;
    turn: number;
    round: number;
  };
  rules: Record<string, any>;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface PlayerSettings {
  playerId: string;
  gameType: GameType;
  settings: {
    soundEnabled: boolean;
    musicEnabled: boolean;
    chatEnabled: boolean;
    autoMuck: boolean;
    showTimer: boolean;
    showPotOdds: boolean;
    showHandStrength: boolean;
    theme: 'light' | 'dark' | 'system';
    language: string;
    timeZone: string;
  };
  lastUpdated: Date;
}

export class GameConfigService {
  private static instance: GameConfigService;
  private gameConfigs: Map<string, GameConfig>;
  private playerSettings: Map<string, PlayerSettings>;
  private readonly defaultConfigs: Partial<GameConfig>[] = [
    // currently all placeholders
    {
      gameType: 'california_poker',
      name: 'California Poker',
      description: '',
      minPlayers: 2,
      maxPlayers: 9,
      startingStack: 1000,
      blinds: {
        small: 5,
        big: 10,
      },
      timeLimits: {
        action: 30,
        turn: 60,
        round: 300,
      },
      rules: {
        allowStraddle: true,
        allowRunItTwice: true,
        allowInsurance: true,
      },
    },
    {
      gameType: 'krunk',
      name: 'Krunk',
      description: '',
      minPlayers: 2,
      maxPlayers: 8,
      startingStack: 500,
      timeLimits: {
        action: 20,
        turn: 60,
        round: 180,
      },
      rules: {
        wordLength: 5,
        maxHints: 3,
        pointsPerGuess: 10,
      },
    },
    {
      gameType: 'exotic_poker',
      name: 'Exotic Poker',
      description: '',
      minPlayers: 2,
      maxPlayers: 6,
      startingStack: 2000,
      blinds: {
        small: 10,
        big: 20,
      },
      timeLimits: {
        action: 25,
        turn: 45,
        round: 240,
      },
      rules: {
        wildCards: true,
        specialHands: true,
        allowSplitting: true,
      },
    },
  ];

  private constructor() {
    this.gameConfigs = new Map();
    this.playerSettings = new Map();
    this.initializeConfigs();
  }

  private initializeConfigs(): void {
    this.defaultConfigs.forEach((config) => {
      if (config.gameType) {
        this.createGameConfig({
          ...config,
          id: config.gameType,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as GameConfig);
      }
    });
  }

  public static getInstance(): GameConfigService {
    if (!GameConfigService.instance) {
      GameConfigService.instance = new GameConfigService();
    }
    return GameConfigService.instance;
  }

  public createGameConfig(config: GameConfig): void {
    this.gameConfigs.set(config.id, config);
  }

  public getGameConfig(gameType: GameType): GameConfig {
    const config = this.gameConfigs.get(gameType);
    if (!config) {
      throw new AppError(ErrorCodes.SYSTEM.NOT_FOUND, 'Game configuration not found', 404);
    }
    return config;
  }

  public updateGameConfig(gameType: GameType, updates: Partial<GameConfig>): void {
    const config = this.getGameConfig(gameType);
    const updatedConfig: GameConfig = {
      ...config,
      ...updates,
      updatedAt: new Date(),
    };
    this.gameConfigs.set(gameType, updatedConfig);
  }

  public getAllGameConfigs(): GameConfig[] {
    return Array.from(this.gameConfigs.values());
  }

  public getActiveGameConfigs(): GameConfig[] {
    return Array.from(this.gameConfigs.values()).filter((config) => config.isActive);
  }

  public getPlayerSettings(playerId: string, gameType: GameType): PlayerSettings {
    const key = `${playerId}-${gameType}`;
    const settings = this.playerSettings.get(key);
    if (!settings) {
      return {
        playerId,
        gameType,
        settings: {
          soundEnabled: true,
          musicEnabled: true,
          chatEnabled: true,
          autoMuck: true,
          showTimer: true,
          showPotOdds: true,
          showHandStrength: true,
          theme: 'system',
          language: 'en',
          timeZone: 'UTC',
        },
        lastUpdated: new Date(),
      };
    }
    return settings;
  }

  public updatePlayerSettings(
    playerId: string,
    gameType: GameType,
    updates: Partial<PlayerSettings['settings']>,
  ): void {
    const key = `${playerId}-${gameType}`;
    const currentSettings = this.getPlayerSettings(playerId, gameType);
    const updatedSettings: PlayerSettings = {
      ...currentSettings,
      settings: {
        ...currentSettings.settings,
        ...updates,
      },
      lastUpdated: new Date(),
    };
    this.playerSettings.set(key, updatedSettings);
  }

  public resetPlayerSettings(playerId: string, gameType: GameType): void {
    const key = `${playerId}-${gameType}`;
    this.playerSettings.delete(key);
  }

  public getGameRules(gameType: GameType): any {
    const config = this.getGameConfig(gameType);
    return config.rules;
  }

  public updateGameRules(gameType: GameType, rules: any): void {
    const config = this.getGameConfig(gameType);
    this.updateGameConfig(gameType, {
      ...config,
      rules: {
        ...config.rules,
        ...rules,
      },
    });
  }

  public getTimeLimits(gameType: GameType): GameConfig['timeLimits'] {
    const config = this.getGameConfig(gameType);
    return config.timeLimits;
  }

  public updateTimeLimits(gameType: GameType, timeLimits: Partial<GameConfig['timeLimits']>): void {
    const config = this.getGameConfig(gameType);
    this.updateGameConfig(gameType, {
      ...config,
      timeLimits: {
        ...config.timeLimits,
        ...timeLimits,
      },
    });
  }

  public getBlinds(gameType: GameType): GameConfig['blinds'] {
    const config = this.getGameConfig(gameType);
    return config.blinds;
  }

  public updateBlinds(gameType: GameType, blinds: Partial<GameConfig['blinds']>): void {
    const config = this.getGameConfig(gameType);
    this.updateGameConfig(gameType, {
      ...config,
      blinds: {
        ...config.blinds,
        ...blinds,
      },
    });
  }

  public toggleGameActive(gameType: GameType): void {
    const config = this.getGameConfig(gameType);
    this.updateGameConfig(gameType, {
      ...config,
      isActive: !config.isActive,
    });
  }

  public cleanupOldSettings(): void {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 30);

    for (const [key, settings] of this.playerSettings.entries()) {
      if (settings.lastUpdated < cutoffDate) {
        this.playerSettings.delete(key);
      }
    }
  }
}
