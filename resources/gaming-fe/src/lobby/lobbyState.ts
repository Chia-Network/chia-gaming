import { v4 as uuidv4 } from "uuid";
import {
  Player,
  Room,
  GameType,
  GameTypes,
  GameDefinition,
  MatchmakingPreferences,
} from "../types/lobby";

const ROOM_TTL = 10 * 60 * 1000;
const GAME_TTL = 10 * 60 * 1000;
const CLEANUP_INTERVAL = 60 * 1000;

function listOfObject<T>(object: Record<string, T>): T[] {
  const result: T[] = [];
  Object.keys(object).forEach((k) => {
    result.push(object[k]);
  });
  return result;
}

export class Lobby {
  players: Record<string, Player> = {};
  rooms: Record<string, Room> = {};
  games: Record<string, GameDefinition> = {};

  sweep(time: number) {
    let playersInRooms: Record<string, boolean> = {};
    Object.keys(this.games).forEach((k) => {
      const game = this.games[k];
      if (time > game.expiration) {
        delete this.games[k];
      }
    });

    Object.keys(this.rooms).forEach((k) => {
      const room: Room = this.rooms[k];
      if (time > room.expiresAt) {
        delete this.rooms[k];
        return;
      }

      if (room.host) {
        playersInRooms[room.host] = true;
      }
      if (room.joiner) {
        playersInRooms[room.joiner] = true;
      }
    });

    Object.keys(this.players).forEach((k) => {
      const player = this.players[k];
      if (!playersInRooms[player.id] && time > player.lastActive + ROOM_TTL) {
        delete this.players[k];
      }
    });
  }

  addPlayer(player: Player) {
    this.players[player.id] = player;
  }

  removePlayer(playerId: string) {
    let existing = !!this.players[playerId];
    delete this.players[playerId];
    return existing;
  }

  addGame(time: number, game: string, target: string) {
    if (this.games[game]) {
      return;
    }

    this.games[game] = {
      expiration: time + GAME_TTL,
      game: game,
      target: target,
    };
  }

  createRoom(host: string, preferences: MatchmakingPreferences) {
    const room: Room = {
      token: uuidv4(),
      minPlayers: 0,
      game: preferences.game,
      parameters: preferences.parameters,
      host,
      createdAt: Date.now(),
      expiresAt: Date.now() + ROOM_TTL,
      status: "waiting",
      maxPlayers: 2,
      chat: [],
    };
    this.rooms[room.token] = room;
    return room;
  }

  joinRoom(roomId: string, player: Player) {
    const room = this.rooms[roomId];
    if (!room || room.status !== "waiting") {
      return null;
    }

    return room;
  }

  leaveRoom(roomId: string, playerId: string) {
    const room = this.rooms[roomId];
    if (!room) return false;

    return true;
  }

  removeRoom(roomId: string) {
    delete this.rooms[roomId];
  }

  getPlayers(): Player[] {
    return listOfObject(this.players);
  }

  getRooms(): Room[] {
    return listOfObject(this.rooms);
  }
}
