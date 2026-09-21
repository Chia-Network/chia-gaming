import type {
  DurableRejectionTombstone,
  DurableStorageAuthority,
  StorageAuthorityLostError,
} from './indexedDb';
import type { SessionSave } from './saveEnvelope';
import type { WalletOperationEntry } from './walletOperationStore';

export type StorageMutationResult =
  | { status: 'committed' }
  | { status: 'failed'; error: unknown }
  | { status: 'authority-lost'; error: StorageAuthorityLostError };
export type StorageLifecycleEvent = 'claim' | 'authority-lost' | 'hard-reset';
export type BootStorageHydrationResult =
  | {
      status: 'ready';
      discardedSession: boolean;
      durableSession: SessionSave | null;
    }
  | { status: 'failed'; error: string };
export type StorageRecordMutation =
  | ['write-session', SessionSave]
  | ['delete-session']
  | ['write-wallet-operations', WalletOperationEntry[]]
  | ['delete-wallet-operations']
  | ['write-rejection', DurableRejectionTombstone]
  | ['replace-session-with-rejection', DurableRejectionTombstone]
  | ['delete-rejection', string, string]
  | ['prune-rejections'];

export interface QueuedStorageMutation {
  authority: DurableStorageAuthority;
  run: () => Promise<void>;
  resolve: (result: StorageMutationResult) => void;
}
