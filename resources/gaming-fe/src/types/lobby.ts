import { z } from 'zod';

export type GameType = 'california_poker' | 'krunk' | 'exotic_poker';

export interface Player {
  id: string;
  walletAddress: string;
  name: string;
  joinedAt: Date;
  lastActive: Date;
}

export interface ChatMessage {
  sender: string;
  text: string;
  timestamp: Date;
}

export interface Room {
  id: string;
  name: string;
  gameType: GameType;
  minPlayers: number;
  maxPlayers: number;
  status: 'waiting' | 'in_progress' | 'completed';
  players: Player[];
  createdAt: Date;
  startedAt?: Date;
  endedAt?: Date;
}

export interface MatchmakingPreferences {
  gameType: GameType;
  minPlayers: number;
  maxPlayers: number;
}

export interface GameSession {
  id: string;
  roomId: string;
  gameType: GameType;
  players: Player[];
  startedAt: Date;
  status: 'in_progress' | 'completed';
  winner?: string;
}

export const gameTypeSchema = z.enum(['california_poker', 'krunk', 'exotic_poker']);

export const playerSchema = z.object({
  id: z.string(),
  walletAddress: z.string(),
  name: z.string(),
  joinedAt: z.date(),
  lastActive: z.date()
});

export const chatMessageSchema = z.object({
  sender: z.string(),
  text: z.string(),
  timestamp: z.date()
});

export const roomSchema = z.object({
  id: z.string(),
  name: z.string(),
  gameType: gameTypeSchema,
  minPlayers: z.number().min(2).max(10),
  maxPlayers: z.number().min(2).max(10),
  status: z.enum(['waiting', 'in_progress', 'completed']),
  players: z.array(playerSchema),
  createdAt: z.date(),
  startedAt: z.date().optional(),
  endedAt: z.date().optional()
});

export const matchmakingPreferencesSchema = z.object({
  gameType: gameTypeSchema,
  minPlayers: z.number().min(2).max(10),
  maxPlayers: z.number().min(2).max(10)
});

export const gameSessionSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  gameType: gameTypeSchema,
  players: z.array(playerSchema),
  startedAt: z.date(),
  status: z.enum(['in_progress', 'completed']),
  winner: z.string().optional()
}); 