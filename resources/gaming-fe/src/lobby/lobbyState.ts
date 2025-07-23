import { v4 as uuidv4 } from 'uuid';
import { Player, Room, GameType, GameTypes, GameSession, MatchmakingPreferences } from '../types/lobby';

const ROOM_TTL = 10 * 60 * 1000;
const CLEANUP_INTERVAL = 60 * 1000;

export const players: Record<string, Player> = {};
export const rooms: Record<string, Room> = {};
export const games: { [id: string]: string; } = {'calpoker': 'http://localhost:3001/?game=calpoker'};
const gameSessions = new Map<string, GameSession>();

export const addPlayer = (player: Player) => {
  players[player.id] = player;
};

export const removePlayer = (playerId: string): boolean => {
  let existing = !!players[playerId];
  delete players[playerId];
  return existing;
};

export const createRoom = (host: string, preferences: MatchmakingPreferences): Room => {
  const room: Room = {
    token: uuidv4(),
    minPlayers: 0,
    game: preferences.game,
    parameters: preferences.parameters,
    host,
    createdAt: Date.now(),
    expiresAt: Date.now() + ROOM_TTL,
    status: 'waiting',
    maxPlayers: getMaxPlayers(preferences.game, preferences.parameters),
    chat: []
  };
  rooms[room.token] = room;
  return room;
};

export const joinRoom = (roomId: string, player: Player): Room | null => {
  const room = rooms[roomId];
  if (!room || room.status !== 'waiting') {
    return null;
  }

  return room;
};

export const leaveRoom = (roomId: string, playerId: string): boolean => {
  const room = rooms[roomId];
  if (!room) return false;

  // Close room if the host or joiner leaves.

  return true;
};

export const findMatch = (player: Player, preferences: MatchmakingPreferences): Room | null => {
  const availableRooms: Room[] = [];
  Object.keys(rooms).forEach((k) => {
    availableRooms.push(rooms[k]);
  });
  availableRooms
    .filter(room =>
      room.game === preferences.game &&
      room.status === 'waiting' &&
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
    roomId: room.token,
    gameType: room.game,
    host: room.host,
    joiner: (room.joiner as string),
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

  const room = rooms[session.roomId];
  if (room) {
    room.status = 'completed';
  }

  return session;
};

const getMaxPlayers = (gameType: GameType, parameters: any): number => {
  return 2;
};

const areParametersCompatible = (roomParams: any, playerParams: any): boolean => {
  return JSON.stringify(roomParams) === JSON.stringify(playerParams);
};

const cleanup = (now: number) => {
  Object.keys(rooms).forEach((roomId) => {
    let room = rooms[roomId];
    if (now > room.expiresAt) {
      // Remove players corresponding to .host and .joiner
      delete rooms[roomId];
    }
  });
};

function listOfObject<T>(object: Record<string, T>): T[] {
  const result: T[] = [];
  Object.keys(object).forEach((k) => {
    result.push(object[k]);
  });
  return result;
}

export const getPlayers = (): Player[] => listOfObject(players);
export const getLobbyQueue = getPlayers;
export const getRooms = (): Room[] => listOfObject(rooms);
export const getGameSessions = (): GameSession[] => Array.from(gameSessions.values());
