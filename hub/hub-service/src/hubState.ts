import crypto from 'node:crypto';

import {
  Player,
  PlayerStatus,
  Challenge,
} from './types/hub';

function randomHex(): string {
  return crypto.randomBytes(16).toString('hex');
}

function listOfObject<T>(object: Record<string, T>): T[] {
  return Object.keys(object).map((k) => object[k]);
}

export class Hub {
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

  /** Returns false when the player is not in the lobby (busy deferred until join). */
  setPlayerStatus(playerId: string, status: PlayerStatus, opponentAlias?: string): boolean {
    const player = this.players[playerId];
    if (!player) return false;
    player.status = status;
    player.opponent_alias = opponentAlias;
    return true;
  }

  getPlayers(): Player[] {
    return listOfObject(this.players);
  }

  createChallenge(fromId: string, targetId: string, challengerAmount: string, targetAmount: string, channel_timeout?: string, unroll_timeout?: string): Challenge {
    const challenge: Challenge = {
      id: randomHex(),
      from_id: fromId,
      target_id: targetId,
      challenger_amount: challengerAmount,
      target_amount: targetAmount,
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
