import { MIN_NONZERO_FEE_MOJOS } from '../../constants/fees';
import type {
  BlockchainType,
  ChiaNetwork,
  SessionPreferencesSave,
  SessionSave,
} from './saveEnvelope';

export interface SessionPreferenceQueries {
  myHubPlayerId: string | undefined;
  blockchainType: BlockchainType | undefined;
  network: ChiaNetwork;
  alias: string | undefined;
  theme: 'dark' | 'light' | undefined;
  defaultFee: bigint;
  feeUnit: 'mojo' | 'xch';
  activeTab: string | undefined;
  unreadGame: boolean;
  walletAlert: boolean;
  hubAlert: boolean;
  hubUrl: string | undefined;
}

export type SessionPreferenceUpdate =
  | { key: 'network'; value: ChiaNetwork }
  | { key: 'alias'; value: string }
  | { key: 'theme'; value: 'dark' | 'light' }
  | { key: 'defaultFee'; value: bigint }
  | { key: 'feeUnit'; value: 'mojo' | 'xch' }
  | { key: 'activeTab'; value: string }
  | { key: 'unreadGame' | 'walletAlert' | 'hubAlert'; value: boolean }
  | { key: 'hubUrl'; value: string | undefined };

export function hasConnectionPreferences(state: SessionSave, hasWalletStorage: boolean): boolean {
  return !!(state.preferences.blockchainType || state.preferences.hubUrl || hasWalletStorage);
}

export function selectSessionPreference<K extends keyof SessionPreferenceQueries>(
  state: SessionSave,
  key: K,
): SessionPreferenceQueries[K] {
  const preferences = state.preferences;
  const values: SessionPreferenceQueries = {
    myHubPlayerId: state.identity.myHubPlayerId,
    blockchainType: preferences.blockchainType,
    network: preferences.network ?? 'mainnet',
    alias: preferences.alias,
    theme: preferences.theme,
    defaultFee: preferences.defaultFee ?? MIN_NONZERO_FEE_MOJOS,
    feeUnit: preferences.feeUnit ?? 'mojo',
    activeTab: preferences.activeTab,
    unreadGame: preferences.unreadGame ?? false,
    walletAlert: preferences.walletAlert ?? false,
    hubAlert: preferences.hubAlert ?? false,
    hubUrl: preferences.hubUrl,
  };
  return values[key];
}

export function applySessionPreferenceUpdate(
  state: SessionSave,
  update: SessionPreferenceUpdate,
): SessionSave {
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
      return { hubUrl: update.value || undefined };
    default:
      return { [update.key]: update.value };
  }
}
