import {
  SESSION_SAVE_SCHEMA,
  SESSION_SAVE_VERSION,
  type BlockchainType,
  type ChiaNetwork,
  type SessionSave,
} from '../lib/session/saveEnvelope';
import { randomHex } from './saveCoordination';

const STATE_KEY = 'appState';
export const PREFERENCES_KEY = 'appPreferences';

interface StoredPreferences {
  playerId: string;
  sessionId?: string;
  myHubPlayerId?: string;
  alias?: string;
  theme?: 'dark' | 'light';
  defaultFee?: string;
  feeUnit?: 'mojo' | 'xch';
  hubUrl?: string;
  activeTab?: string;
  unreadGame?: boolean;
  walletAlert?: boolean;
  hubAlert?: boolean;
  blockchainType?: BlockchainType;
  network?: ChiaNetwork;
}

export function savePreferences(state: SessionSave): void {
  const preferences: StoredPreferences = {
    playerId: state.identity.playerId,
    sessionId: state.identity.sessionId,
    myHubPlayerId: state.identity.myHubPlayerId,
    alias: state.preferences.alias,
    theme: state.preferences.theme,
    defaultFee: state.preferences.defaultFee?.toString(),
    feeUnit: state.preferences.feeUnit,
    hubUrl: state.preferences.hubUrl,
    activeTab: state.preferences.activeTab,
    unreadGame: state.preferences.unreadGame,
    walletAlert: state.preferences.walletAlert,
    hubAlert: state.preferences.hubAlert,
    blockchainType: state.preferences.blockchainType,
    network: state.preferences.network,
  };
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch (error) {
    console.error('[save] failed to persist preferences:', error);
  }
}

export function loadPreferences(): SessionSave {
  try {
    // The obsolete payload may contain arbitrary stale encoding. Never inspect it.
    localStorage.removeItem(STATE_KEY);
    const raw = localStorage.getItem(PREFERENCES_KEY);
    if (raw) {
      const preferences = JSON.parse(raw) as StoredPreferences;
      if (typeof preferences.playerId === 'string') {
        return {
          schema: SESSION_SAVE_SCHEMA,
          version: SESSION_SAVE_VERSION,
          phase: 'preferences',
          identity: {
            playerId: preferences.playerId,
            sessionId: preferences.sessionId,
            myHubPlayerId: preferences.myHubPlayerId,
          },
          preferences: {
            alias: preferences.alias,
            theme: preferences.theme,
            defaultFee:
              preferences.defaultFee === undefined ? undefined : BigInt(preferences.defaultFee),
            feeUnit: preferences.feeUnit,
            hubUrl: preferences.hubUrl,
            activeTab: preferences.activeTab,
            unreadGame: preferences.unreadGame,
            walletAlert: preferences.walletAlert,
            hubAlert: preferences.hubAlert,
            blockchainType: preferences.blockchainType,
            network: preferences.network,
          },
          history: {},
        };
      }
    }
  } catch (error) {
    console.error('[save] failed to load preferences:', error);
  }
  return {
    schema: SESSION_SAVE_SCHEMA,
    version: SESSION_SAVE_VERSION,
    phase: 'preferences',
    identity: { playerId: randomHex() },
    preferences: {},
    history: {},
  };
}

export function writeRawObsoleteState(obj: Record<string, unknown>): void {
  localStorage.setItem(STATE_KEY, JSON.stringify(obj));
}
