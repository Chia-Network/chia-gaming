import crypto from 'crypto';

import {
  Player,
  GameDefinition,
  Challenge,
  Pairing,
} from './types/lobby';

const PLAYER_TTL = 10 * 60 * 1000;
const GAME_TTL = 10 * 60 * 1000;

function randomHex(): string {
  return crypto.randomBytes(16).toString('hex');
}

function listOfObject<T>(object: Record<string, T>): T[] {
  return Object.keys(object).map((k) => object[k]);
}

export class Lobby {
  players: Record<string, Player> = {};
  games: Record<string, GameDefinition> = {};
  challenges: Map<string, Challenge> = new Map();
  pairings: Map<string, Pairing> = new Map();
  // Reverse lookup: player_id -> token for the pairing they're in
  playerToPairing: Map<string, string> = new Map();

  sweep(time: number) {
    Object.keys(this.games).forEach((k) => {
      if (time > this.games[k].expiration) {
        delete this.games[k];
      }
    });

    Object.keys(this.players).forEach((k) => {
      const player = this.players[k];
      if (time > player.lastActive + PLAYER_TTL) {
        delete this.players[k];
      }
    });
  }

  addPlayer(player: Player) {
    this.players[player.id] = player;
  }

  removePlayer(playerId: string) {
    const existing = !!this.players[playerId];
    delete this.players[playerId];
    return existing;
  }

  addGame(time: number, game: string, target: string) {
    if (this.games[game]) return;
    this.games[game] = {
      expiration: time + GAME_TTL,
      game,
      target,
    };
  }

  getPlayers(): Player[] {
    return listOfObject(this.players);
  }

  getTracking(): string[] {
    return listOfObject(this.games).map((g) => g.target);
  }

  getGames(): GameDefinition[] {
    return listOfObject(this.games);
  }

  createChallenge(fromId: string, targetId: string, game: string, amount: string, perGame: string): Challenge {
    const challenge: Challenge = {
      id: randomHex(),
      from_id: fromId,
      target_id: targetId,
      game,
      amount,
      per_game: perGame,
    };
    this.challenges.set(challenge.id, challenge);
    return challenge;
  }

  getChallenge(challengeId: string): Challenge | undefined {
    return this.challenges.get(challengeId);
  }

  removeChallenge(challengeId: string) {
    this.challenges.delete(challengeId);
  }

  createPairing(playerAId: string, playerBId: string, gameType: string, amount: string, perGame: string): Pairing {
    const token = randomHex();
    const pairing: Pairing = {
      playerA_id: playerAId,
      playerB_id: playerBId,
      token,
      game_type: gameType,
      amount,
      per_game: perGame,
    };
    this.pairings.set(token, pairing);
    this.playerToPairing.set(playerAId, token);
    this.playerToPairing.set(playerBId, token);
    return pairing;
  }

  getPairingForPlayer(playerId: string): Pairing | undefined {
    const token = this.playerToPairing.get(playerId);
    if (!token) return undefined;
    return this.pairings.get(token);
  }

  getPairedPlayerId(playerId: string): string | undefined {
    const pairing = this.getPairingForPlayer(playerId);
    if (!pairing) return undefined;
    if (pairing.playerA_id === playerId) return pairing.playerB_id;
    return pairing.playerA_id;
  }

  removePairing(token: string) {
    const pairing = this.pairings.get(token);
    if (pairing) {
      this.playerToPairing.delete(pairing.playerA_id);
      this.playerToPairing.delete(pairing.playerB_id);
      this.pairings.delete(token);
    }
  }
}
