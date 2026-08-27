import 'fake-indexeddb/auto';
import { calpokerStateCodec } from '@games/calpoker/ui/serialize';
import {
  CURRENT_VERSION,
  _resetForTests,
  type SessionPresentationSave,
  type SessionSave,
} from '../../hooks/save';
import { SESSION_SAVE_SCHEMA } from '../session/saveEnvelope';
import { deleteSessionRecord } from '../session/indexedDb';

export const ACTIVE_INSTANCE = {
  id: 'game-1',
  amount: '20',
  coinHex: null,
  presentation: 'off-chain-my-turn' as const,
  terminal: {
    type: 'none',
    outcome: null,
    label: null,
    myReward: null,
    rewardCoinHex: null,
  },
};

export const TERMINAL_INSTANCE = {
  id: 'game-1',
  amount: '20',
  coinHex: null,
  presentation: 'ended' as const,
  terminal: {
    type: 'settled',
    outcome: 'settled_cleanly',
    label: 'Settled cleanly',
    myReward: '20',
    rewardCoinHex: null,
  },
};

function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (index) => [...store.keys()][index] ?? null,
  };
}

function setTestGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

type LegacyFields = Record<string, any>;

const PRESENTATION_KEYS = new Set([
  'activeGameIds',
  'currentHandGameIds',
  'currentHandOrigin',
  'lastDisplayedGameId',
  'activeGameType',
  'gameInstances',
  'handState',
  'channelStatus',
  'myRunningBalance',
  'channelNotifQueue',
  'gameNotifQueue',
  'dismissedChannelStatus',
  'cleanShutdownStarted',
  'betweenHandMode',
  'betweenHandCompose',
  'betweenHandLastHandProposal',
  'betweenHandRejectedOnceHandProposal',
  'betweenHandPendingRetryHandProposal',
  'proposalGroups',
  'waitingStateEnteredAt',
  'cleanShutdownGraceStartedAt',
]);

function common(fields: LegacyFields) {
  return {
    schema: SESSION_SAVE_SCHEMA,
    version: CURRENT_VERSION,
    identity: {
      playerId: fields.playerId ?? 'player',
      sessionId: fields.sessionId,
      myHubPlayerId: fields.myHubPlayerId,
    },
    preferences: {
      alias: fields.alias,
      theme: fields.theme,
      defaultFee: fields.defaultFee,
      feeUnit: fields.feeUnit,
      hubUrl: fields.hubUrl,
      activeTab: fields.activeTab,
      unreadGame: fields.unreadGame,
      walletAlert: fields.walletAlert,
      hubAlert: fields.hubAlert,
      blockchainType: fields.blockchainType,
    },
    history: {
      humanHistory: fields.humanHistory,
      wasmNotificationHistory: fields.wasmNotificationHistory,
      diagnosticLog: fields.diagnosticLog,
    },
  };
}

function presentation(fields: LegacyFields): SessionPresentationSave {
  const perGameAmount =
    typeof fields.perGameAmount === 'string' &&
    /^\d+$/.test(fields.perGameAmount) &&
    BigInt(fields.perGameAmount) > 0n
      ? fields.perGameAmount
      : '20';
  const result: LegacyFields = {
    activeGameIds: [],
    currentHandGameIds: [],
    currentHandOrigin: null,
    lastDisplayedGameId: null,
    gameInstances: {},
    activeGameType: 'calpoker',
    handState: null,
    channelStatus: null,
    myRunningBalance: '0',
    channelNotifQueue: [],
    gameNotifQueue: [],
    dismissedChannelStatus: null,
    cleanShutdownStarted: false,
    betweenHandMode: 'decision',
    betweenHandCompose: {
      selected_game: 'calpoker',
      game_timeout: '15',
      proposal_sent: false,
    },
    betweenHandLastHandProposal: {
      player_a_contribution: perGameAmount,
      player_b_contribution: perGameAmount,
      sender_is_player_a: false,
      game_timeout: '15',
      game_type: 'calpoker',
      parameters: null,
    },
    betweenHandRejectedOnceHandProposal: null,
    betweenHandPendingRetryHandProposal: null,
    proposalGroups: [],
    waitingStateEnteredAt: null,
    cleanShutdownGraceStartedAt: null,
  };
  for (const key of PRESENTATION_KEYS) {
    if (fields[key] !== undefined) result[key] = fields[key];
  }
  if (result.channelStatus !== null && result.channelStatus !== undefined) {
    result.channelStatus = {
      advisory: null,
      coin: null,
      our_balance: null,
      their_balance: null,
      game_allocated: null,
      ...result.channelStatus,
    };
  }
  return result;
}

function pairing(fields: LegacyFields) {
  return {
    token: fields.pairingToken,
    peerId: fields.sessionPeerId,
    gameSessionId: fields.gameSessionId,
    iStarted: fields.iStarted,
    myContribution: fields.myContribution,
    theirContribution: fields.theirContribution,
    perGameAmount: fields.perGameAmount,
    channelTimeout: fields.channelTimeout,
    unrollTimeout: fields.unrollTimeout,
    myAlias: fields.myAlias,
    opponentAlias: fields.opponentAlias,
  };
}

export function baseSave(fields: LegacyFields = {}): SessionSave {
  const shared = common(fields);
  if (
    fields.channelStatus?.state?.startsWith('Resolved') ||
    fields.channelStatus?.state === 'Failed' ||
    fields.channelStatus?.session_disposition === 'Abandoned'
  ) {
    return {
      ...shared,
      phase: 'terminal',
      terminal: {
        iStarted: fields.terminalIStarted ?? false,
        coinsOfInterest: fields.coinsOfInterest,
        myAlias: fields.myAlias ?? null,
        opponentAlias: fields.opponentAlias ?? null,
      },
      presentation: presentation(fields),
    };
  }
  if (fields.pairingToken !== undefined) {
    const invalidPresentation = [...PRESENTATION_KEYS].some(
      (key) => key !== 'activeGameIds' && fields[key] !== undefined,
    );
    return {
      ...shared,
      phase: 'pre-handshake',
      pairing: pairing(fields),
      ...(invalidPresentation ? { presentation: presentation(fields) } : {}),
    } as SessionSave;
  }
  const invalidPresentation = [...PRESENTATION_KEYS].some((key) => fields[key] !== undefined);
  return {
    ...shared,
    phase: 'preferences',
    ...(invalidPresentation ? { presentation: presentation(fields) } : {}),
  } as SessionSave;
}

export function activeSave(fields: LegacyFields = {}): SessionSave {
  const merged = {
    serializedGameSession: new Uint8Array([1, 2, 3]),
    gameSessionSchemaVersion: 3n,
    pairingToken: 'pair',
    messageNumber: 1n,
    remoteNumber: 0n,
    iStarted: true,
    myContribution: '20',
    theirContribution: '20',
    perGameAmount: '20',
    rewardPuzzleHash: '11'.repeat(32),
    unackedMessages: [],
    activeGameIds: ['game-1'],
    currentHandGameIds: ['game-1'],
    currentHandOrigin: 'local',
    lastDisplayedGameId: 'game-1',
    activeGameType: 'calpoker',
    gameInstances: { 'game-1': ACTIVE_INSTANCE },
    handState: calpokerStateCodec.encode({
      playerHand: [1n, 2n],
      opponentHand: [3n, 4n],
      moveNumber: 1n,
      isPlayerTurn: true,
      iStarted: true,
      error: null,
    }),
    betweenHandLastHandProposal: {
      player_a_contribution: '20',
      player_b_contribution: '20',
      sender_is_player_a: false,
      game_timeout: '15',
      game_type: 'calpoker',
      parameters: null,
    },
    ...fields,
  };
  return {
    ...common(merged),
    phase: 'live',
    pairing: pairing(merged),
    live: {
      serializedGameSession: merged.serializedGameSession,
      gameSessionSchemaVersion: merged.gameSessionSchemaVersion,
      rewardPuzzleHash: merged.rewardPuzzleHash,
      messageNumber: merged.messageNumber,
      remoteNumber: merged.remoteNumber,
      unackedMessages: merged.unackedMessages,
      durabilityWarning: merged.durabilityWarning,
    },
    presentation: presentation(merged),
    ...(merged.terminalIStarted !== undefined || merged.coinsOfInterest !== undefined
      ? {
          terminal: {
            iStarted: merged.terminalIStarted,
            coinsOfInterest: merged.coinsOfInterest,
          },
        }
      : {}),
  } as SessionSave;
}

export function liveSave(fields: LegacyFields = {}): SessionSave {
  const merged = {
    serializedGameSession: new Uint8Array([1, 2, 3]),
    gameSessionSchemaVersion: 3n,
    pairingToken: 'pair',
    messageNumber: 1n,
    remoteNumber: 0n,
    iStarted: true,
    myContribution: '20',
    theirContribution: '20',
    perGameAmount: '20',
    rewardPuzzleHash: '11'.repeat(32),
    unackedMessages: [],
    activeGameIds: [],
    ...fields,
  };
  return {
    ...common(merged),
    phase: 'live',
    pairing: pairing(merged),
    live: {
      serializedGameSession: merged.serializedGameSession,
      gameSessionSchemaVersion: merged.gameSessionSchemaVersion,
      rewardPuzzleHash: merged.rewardPuzzleHash,
      messageNumber: merged.messageNumber,
      remoteNumber: merged.remoteNumber,
      unackedMessages: merged.unackedMessages,
      durabilityWarning: merged.durabilityWarning,
    },
    presentation: presentation(merged),
  };
}

export function installSessionEnvelopeTestSetup(): void {
  beforeEach(async () => {
    _resetForTests();
    setTestGlobal('localStorage', makeStorage());
    setTestGlobal('sessionStorage', makeStorage());
    await deleteSessionRecord();
  });

  afterEach(() => {
    _resetForTests();
  });
}
