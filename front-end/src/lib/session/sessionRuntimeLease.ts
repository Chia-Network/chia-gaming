import type { SessionModel } from './types';

export interface ReliableCommitCoordinator {
  retire(): void;
  requestCommit(): void;
  flush(): Promise<void>;
  enqueue(work: () => void): void;
  enqueueResult<T>(work: () => T): Promise<T>;
  releaseAfterPersistence(key: string, launcher: () => Promise<void>): Promise<void>;
}

export interface SessionRuntimeLease extends ReliableCommitCoordinator {
  snapshotModel(): SessionModel;
}
