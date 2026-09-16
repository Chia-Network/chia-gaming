import crypto from 'node:crypto';

import { Player, PlayerStatus, Challenge } from './types/hub';

function randomHex(): string {
  return crypto.randomBytes(16).toString('hex');
}

function listOfObject<T>(object: Record<string, T>): T[] {
  return Object.keys(object).map((k) => object[k]);
}

export class Hub {
  players: Record<string, Player> = {};
  challenges: Map<string, Challenge> = new Map();
  private readonly challengeByPair = new Map<string, string>();
  private readonly challengeCountBySender = new Map<string, number>();

  addPlayer(player: Player) {
    this.players[player.id] = player;
  }

  removePlayer(playerId: string) {
    const existing = !!this.players[playerId];
    delete this.players[playerId];
    return existing;
  }

  /** Returns false when the player is not in the hub (busy deferred until join). */
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

  createChallenge(
    fromId: string,
    targetId: string,
    challengerAmount: string,
    targetAmount: string,
    channel_timeout?: string,
    unroll_timeout?: string,
    createdAt = Date.now(),
  ): Challenge {
    const pairKey = this.challengePairKey(fromId, targetId);
    if (this.challengeByPair.has(pairKey)) {
      throw new Error(`duplicate challenge pair ${fromId} -> ${targetId}`);
    }
    const challenge: Challenge = {
      id: randomHex(),
      from_id: fromId,
      target_id: targetId,
      challenger_amount: challengerAmount,
      target_amount: targetAmount,
      channel_timeout,
      unroll_timeout,
      created_at: createdAt,
    };
    this.challenges.set(challenge.id, challenge);
    this.challengeByPair.set(pairKey, challenge.id);
    this.challengeCountBySender.set(fromId, (this.challengeCountBySender.get(fromId) ?? 0) + 1);
    return challenge;
  }

  getChallenge(challengeId: string): Challenge | undefined {
    return this.challenges.get(challengeId);
  }

  findChallenge(fromId: string, targetId: string): Challenge | undefined {
    const challengeId = this.challengeByPair.get(this.challengePairKey(fromId, targetId));
    return challengeId ? this.challenges.get(challengeId) : undefined;
  }

  countChallengesFrom(playerId: string): number {
    return this.challengeCountBySender.get(playerId) ?? 0;
  }

  removeExpiredChallenges(now: number, ttlMs: number): Challenge[] {
    const expired: Challenge[] = [];
    for (const [id, challenge] of this.challenges) {
      if (now - challenge.created_at < ttlMs) continue;
      this.removeChallenge(id);
      expired.push(challenge);
    }
    return expired;
  }

  removeChallenge(challengeId: string) {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) return;
    this.challenges.delete(challengeId);
    this.challengeByPair.delete(this.challengePairKey(challenge.from_id, challenge.target_id));
    const remaining = (this.challengeCountBySender.get(challenge.from_id) ?? 1) - 1;
    if (remaining === 0) {
      this.challengeCountBySender.delete(challenge.from_id);
    } else {
      this.challengeCountBySender.set(challenge.from_id, remaining);
    }
  }

  private challengePairKey(fromId: string, targetId: string): string {
    return `${fromId}\0${targetId}`;
  }
}
