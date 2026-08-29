export interface SessionReceivePolicy {
  maxFutureReliableMsgnoGap: bigint;
  maxQueuedMessages: number;
  maxQueuedBytes: number;
  maxPeerBodyBytes: number;
}

export type ReadonlySessionReceivePolicy = Readonly<SessionReceivePolicy>;

export const DEFAULT_SESSION_RECEIVE_POLICY: ReadonlySessionReceivePolicy = Object.freeze({
  maxFutureReliableMsgnoGap: 4096n,
  maxQueuedMessages: 1024,
  maxQueuedBytes: 64 * 1024 * 1024,
  maxPeerBodyBytes: 10 * 1024 * 1024,
});

export function sessionReceivePolicy(
  overrides: Partial<SessionReceivePolicy> = {},
): ReadonlySessionReceivePolicy {
  return Object.freeze({ ...DEFAULT_SESSION_RECEIVE_POLICY, ...overrides });
}
