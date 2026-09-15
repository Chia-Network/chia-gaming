export type Clock = () => number;

export interface RetainedSessionCandidate {
  sessionId: string;
  playerId: string;
}

export function deadlineReached(startedAt: number, durationMs: number, now: number): boolean {
  return now - startedAt >= durationMs;
}

export class RetentionTimeline {
  readonly #lastInactiveAt = new Map<string, number>();

  constructor(private readonly now: Clock = Date.now) {}

  touch(sessionId: string, at = this.now()): void {
    this.#lastInactiveAt.delete(sessionId);
    this.#lastInactiveAt.set(sessionId, at);
  }

  delete(sessionId: string): void {
    this.#lastInactiveAt.delete(sessionId);
  }

  isExpired(sessionId: string, ttlMs: number, at = this.now()): boolean {
    return deadlineReached(this.#lastInactiveAt.get(sessionId) ?? 0, ttlMs, at);
  }

  oldest(candidates: Iterable<RetainedSessionCandidate>): RetainedSessionCandidate | null {
    let oldest: (RetainedSessionCandidate & { inactiveAt: number }) | null = null;
    for (const candidate of candidates) {
      const inactiveAt = this.#lastInactiveAt.get(candidate.sessionId) ?? 0;
      if (!oldest || inactiveAt < oldest.inactiveAt) {
        oldest = { ...candidate, inactiveAt };
      }
    }
    return oldest && { sessionId: oldest.sessionId, playerId: oldest.playerId };
  }

  get size(): number {
    return this.#lastInactiveAt.size;
  }
}
