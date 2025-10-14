export interface GetSyncStatusRequest {}

export interface GetSyncStatusResponse {
  genesisInitialized: boolean;
  synced: boolean;
  syncing: boolean;
  success: true;
}
