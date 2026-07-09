import crypto from 'node:crypto';

import {
  Player,
  PlayerStatus,
  Challenge,
} from './types/lobby';

function randomHex(): string {
  return crypto.randomBytes(16).toString('hex');
}

function listOfObject<T>(object: Record<string, T>): T[] {
  return Object.keys(object).map((k) => object[k]);
}

export class Lobby {
  players: Record<string, Player> = {};
  challenges: Map<string, Challenge> = new Map();

  addPlayer(player: Player) {
    this.players[player.id] = player;
  }

  removePlayer(playerId: string) {
    const existing = !!this.players[playerId];
    delete this.players[playerId];
    return existing;
  }

  setPlayerStatus(playerId: string, status: PlayerStatus, opponentAlias?: string): void {
    const player = this.players[playerId];
    if (!player) return;
    player.status = status;
    player.opponent_alias = opponentAlias;
  }

  getPlayers(): Player[] {
    return listOfObject(this.players);
  }

  createChallenge(fromId: string, targetId: string, amount: string, channel_timeout?: string, unroll_timeout?: string): Challenge {
    const challenge: Challenge = {
      id: randomHex(),
      from_id: fromId,
      target_id: targetId,
      amount,
      channel_timeout,
      unroll_timeout,
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
}
