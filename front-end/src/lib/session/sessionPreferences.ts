import { DEFAULT_FEE_PER_COST } from '../../constants/fees';
import type {
  BlockchainType,
  ChiaNetwork,
  SessionPreferencesSave,
  DurableApplicationState,
} from './saveEnvelope';

export interface SessionPreferenceQueries {
  myHubPlayerId: string | undefined;
  blockchainType: BlockchainType | undefined;
  network: ChiaNetwork;
  alias: string | undefined;
  theme: 'dark' | 'light' | undefined;
  feePerCost: bigint;
  activeTab: string | undefined;
  unreadGame: boolean;
  walletAlert: boolean;
  hubAlert: boolean;
  hubUrl: string | undefined;
  lastHubUrl: string | undefined;
}

export type SessionPreferenceUpdate =
  | { key: 'network'; value: ChiaNetwork }
  | { key: 'alias'; value: string }
  | { key: 'theme'; value: 'dark' | 'light' }
  | { key: 'feePerCost'; value: bigint }
  | { key: 'activeTab'; value: string }
  | { key: 'unreadGame' | 'walletAlert' | 'hubAlert'; value: boolean }
  | { key: 'hubUrl' | 'lastHubUrl'; value: string | undefined };

export function selectSessionPreference<K extends keyof SessionPreferenceQueries>(
  state: DurableApplicationState,
  key: K,
): SessionPreferenceQueries[K] {
  const preferences = state.preferences;
  const values: SessionPreferenceQueries = {
    myHubPlayerId: state.identity.myHubPlayerId,
    blockchainType: preferences.blockchainType,
    network: preferences.network ?? 'mainnet',
    alias: preferences.alias,
    theme: preferences.theme,
    feePerCost: preferences.feePerCost ?? DEFAULT_FEE_PER_COST,
    activeTab: preferences.activeTab,
    unreadGame: preferences.unreadGame ?? false,
    walletAlert: preferences.walletAlert ?? false,
    hubAlert: preferences.hubAlert ?? false,
    hubUrl: preferences.hubUrl,
    lastHubUrl: preferences.lastHubUrl,
  };
  return values[key];
}

export function applySessionPreferenceUpdate(
  state: DurableApplicationState,
  update: SessionPreferenceUpdate,
): DurableApplicationState {
  return {
    ...state,
    preferences: {
      ...state.preferences,
      ...preferencePatch(update),
    },
  };
}

function preferencePatch(update: SessionPreferenceUpdate): Partial<SessionPreferencesSave> {
  switch (update.key) {
    case 'unreadGame':
    case 'walletAlert':
    case 'hubAlert':
      return { [update.key]: update.value || undefined };
    case 'hubUrl':
    case 'lastHubUrl':
      return { [update.key]: update.value || undefined };
    default:
      return { [update.key]: update.value };
  }
}
