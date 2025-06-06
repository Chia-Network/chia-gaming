import { v4 as uuidv4 } from 'uuid';
import { Player, Room, GameType, GameTypes, GameSession, MatchmakingPreferences } from '../types/lobby';

const ROOM_TTL = 10 * 60 * 1000;
const CLEANUP_INTERVAL = 60 * 1000;

const players = new Map<string, Player>();
const rooms = new Map<string, Room>();
const gameSessions = new Map<string, GameSession>();

let cleanupInterval: NodeJS.Timeout;

export const initLobby = () => {
  cleanupInterval = setInterval(cleanup, CLEANUP_INTERVAL);
};

export const shutdownLobby = () => {
  clearInterval(cleanupInterval);
  players.clear();
  rooms.clear();
  gameSessions.clear();
};

export const addPlayer = (player: Omit<Player, 'lastSeen' | 'status'>): Player => {
  const newPlayer: Player = {
    ...player,
    lastActive: Date.now(),
    status: 'waiting'
  };
  players.set(player.id, newPlayer);
  return newPlayer;
};

export const removePlayer = (playerId: string): boolean => {
  return players.delete(playerId);
};

export const updatePlayerStatus = (playerId: string, status: Player['status']): boolean => {
  const player = players.get(playerId);
  if (!player) return false;
  player.status = status;
  player.lastActive = Date.now();
  return true;
};

export const createRoom = (host: Player, preferences: MatchmakingPreferences): Room => {
  const room: Room = {
    id: uuidv4(),
    name: "room",
    minPlayers: 0,
    gameType: preferences.gameType,
    parameters: preferences.parameters,
    host,
    players: [host],
    createdAt: new Date(Date.now()),
    expiresAt: Date.now() + ROOM_TTL,
    status: 'waiting',
    maxPlayers: getMaxPlayers(preferences.gameType, preferences.parameters),
    chat: []
  };
  rooms.set(room.id, room);
  return room;
};

export const joinRoom = (roomId: string, player: Player): Room | null => {
  const room = rooms.get(roomId);
  if (!room || room.status !== 'waiting' || room.players.length >= room.maxPlayers) {
    return null;
  }

  room.players.push(player);
  if (room.players.length === room.maxPlayers) {
    room.status = 'in_progress';
    startGameSession(room);
  }

  return room;
};

export const leaveRoom = (roomId: string, playerId: string): boolean => {
  const room = rooms.get(roomId);
  if (!room) return false;

  const playerIndex = room.players.findIndex(p => p.id === playerId);
  if (playerIndex === -1) return false;

  room.players.splice(playerIndex, 1);
  
  if (room.players.length === 0) {
    rooms.delete(roomId);
  } else if (playerId === room.host.id) {
    room.host = room.players[0];
  }

  return true;
};

export const findMatch = (player: Player, preferences: MatchmakingPreferences): Room | null => {
  const availableRooms = Array.from(rooms.values())
    .filter(room => 
      room.gameType === preferences.gameType &&
      room.status === 'waiting' &&
      room.players.length < room.maxPlayers &&
      areParametersCompatible(room.parameters, preferences.parameters)
    );

  if (availableRooms.length === 0) {
    return null;
  }

  return availableRooms[0];
};

const startGameSession = (room: Room): GameSession => {
  const session: GameSession = {
    id: uuidv4(),
    roomId: room.id,
    players: [...room.players],
    gameType: room.gameType,
    parameters: room.parameters,
    startedAt: Date.now(),
    status: 'active'
  };
  gameSessions.set(session.id, session);
  return session;
};

export const endGameSession = (sessionId: string, winnerId?: string): GameSession | null => {
  const session = gameSessions.get(sessionId);
  if (!session) return null;

  session.status = 'completed';
  if (winnerId) session.winner = winnerId;

  const room = rooms.get(session.roomId);
  if (room) {
    room.status = 'completed';
  }

  return session;
};

const getMaxPlayers = (gameType: GameType, parameters: any): number => {
  switch (gameType) {
    case GameTypes.CALIFORNIA_POKER:
    case GameTypes.EXOTIC_POKER:
      return parameters.maxPlayers;
    case GameTypes.KRUNK:
      return 2;
    default:
      return 2;
  }
};

const areParametersCompatible = (roomParams: any, playerParams: any): boolean => {
  return JSON.stringify(roomParams) === JSON.stringify(playerParams);
};

const cleanup = () => {
  const now = Date.now();

  for (const [roomId, room] of rooms.entries()) {
    if (now > room.expiresAt) {
      rooms.delete(roomId);
    }
  }

  for (const [playerId, player] of players.entries()) {
    if (now - player.lastActive > ROOM_TTL) {
      players.delete(playerId);
    }
  }
};

export const getPlayers = (): Player[] => Array.from(players.values());
export const getRooms = (): Room[] => Array.from(rooms.values());
export const getGameSessions = (): GameSession[] => Array.from(gameSessions.values()); 
