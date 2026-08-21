import { calpokerStateCodec } from '@games/calpoker/ui/serialize';
import { initialKrunkGameState, krunkStateCodec } from '@games/krunk/ui/serialize';
import { spacepokerStateCodec } from '@games/spacepoker/ui/serialize';
import { type SessionPresentationSave, type SessionSave } from '../../hooks/save';
import {
  decodeSessionSaveEnvelope,
  sessionModelFromSave,
  validateSessionSaveEnvelope,
} from '../session/model';
import {
  ACTIVE_INSTANCE,
  TERMINAL_INSTANCE,
  activeSave,
  baseSave,
  installSessionEnvelopeTestSetup,
  liveSave,
} from './session_save_envelope.fixtures';

installSessionEnvelopeTestSetup();

describe('validateSessionSaveEnvelope', () => {
  it('accepts empty preferences and a complete pre-handshake checkpoint', () => {
    expect(() => validateSessionSaveEnvelope(baseSave())).not.toThrow();
    expect(() =>
      validateSessionSaveEnvelope(
        baseSave({
          blockchainType: 'simulator',
          pairingToken: 'pair',
          iStarted: true,
          myContribution: '20',
          theirContribution: '20',
          perGameAmount: '2',
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    [
      'preferences',
      baseSave({
        activeGameIds: ['game-1'],
        currentHandGameIds: ['game-1'],
        lastDisplayedGameId: 'game-1',
        activeGameType: 'calpoker',
        gameInstances: { 'game-1': ACTIVE_INSTANCE },
        handState: calpokerStateCodec.encode({
          playerHand: [1n, 2n],
          opponentHand: [3n, 4n],
          moveNumber: 1n,
          isPlayerTurn: true,
        }),
        betweenHandLastHandProposal: {
          my_contribution: '20',
          their_contribution: '20',
          game_timeout: '15',
          game_type: 'calpoker',
        },
      }),
    ],
    [
      'pre-handshake',
      baseSave({
        pairingToken: 'pair',
        iStarted: true,
        myContribution: '20',
        theirContribution: '20',
        perGameAmount: '20',
        activeGameIds: ['game-1'],
        currentHandGameIds: ['game-1'],
        lastDisplayedGameId: 'game-1',
        activeGameType: 'calpoker',
        gameInstances: { 'game-1': ACTIVE_INSTANCE },
        handState: calpokerStateCodec.encode({
          playerHand: [1n, 2n],
          opponentHand: [3n, 4n],
          moveNumber: 1n,
          isPlayerTurn: true,
        }),
        betweenHandLastHandProposal: {
          my_contribution: '20',
          their_contribution: '20',
          game_timeout: '15',
          game_type: 'calpoker',
        },
      }),
    ],
  ])('rejects a %s record carrying a complete active-game payload', (_kind, save) => {
    expect(() => validateSessionSaveEnvelope(save)).toThrow('unexpected');
  });

  it('rejects terminal records with live protocol fields and live records with terminal fields', () => {
    const live = liveSave();
    const terminal = baseSave({
      channelStatus: { state: 'ResolvedClean' },
      coinsOfInterest: [],
      terminalIStarted: true,
    });
    expect(() =>
      validateSessionSaveEnvelope({
        ...terminal,
        pairing: live.phase === 'live' ? live.pairing : undefined,
        live: live.phase === 'live' ? live.live : undefined,
      } as SessionSave),
    ).toThrow('unexpected');
    expect(() =>
      validateSessionSaveEnvelope({
        ...live,
        terminal: { iStarted: true, coinsOfInterest: [] },
      } as SessionSave),
    ).toThrow('unexpected');
  });

  it('decodes one legitimate snapshot for every v13 phase', () => {
    const preferences = baseSave({ blockchainType: 'simulator' });
    const preHandshake = baseSave({
      pairingToken: 'pair',
      iStarted: false,
      myContribution: '20',
      theirContribution: '20',
      perGameAmount: '2',
    });
    const live = liveSave();
    const terminal = baseSave({
      channelStatus: { state: 'ResolvedClean' },
      coinsOfInterest: [],
      terminalIStarted: true,
      activeGameIds: [],
      currentHandGameIds: ['game-1'],
      currentHandOrigin: 'local',
      lastDisplayedGameId: 'game-1',
      activeGameType: 'calpoker',
      gameInstances: { 'game-1': TERMINAL_INSTANCE },
      betweenHandLastHandProposal: {
        my_contribution: '20',
        their_contribution: '20',
        game_timeout: '15',
        game_type: 'calpoker',
      },
    });
    expect(decodeSessionSaveEnvelope(preferences).phase).toBe('preferences');
    expect(decodeSessionSaveEnvelope(preHandshake).phase).toBe('pre-handshake');
    expect(decodeSessionSaveEnvelope(live).phase).toBe('live');
    expect(decodeSessionSaveEnvelope(terminal).phase).toBe('terminal');
  });

  it.each([
    ['schema', { gameSessionSchemaVersion: undefined }],
    ['message counter', { messageNumber: undefined }],
    ['remote counter', { remoteNumber: undefined }],
    ['role', { iStarted: undefined }],
    ['pairing token', { pairingToken: undefined }],
    ['unacked messages', { unackedMessages: undefined }],
    ['my contribution', { myContribution: undefined }],
    ['their contribution', { theirContribution: undefined }],
    ['per-game amount', { perGameAmount: undefined }],
    ['reward puzzle hash', { rewardPuzzleHash: null }],
  ])('rejects a live resumable record missing its %s', (_label, fields) => {
    expect(() => validateSessionSaveEnvelope(liveSave(fields))).toThrow();
  });

  it('rejects a live/current hand without its game-owned payload', () => {
    const save = activeSave();
    if (save.phase !== 'live') throw new Error('expected live fixture');
    Reflect.deleteProperty(save.presentation, 'handState');
    expect(() => validateSessionSaveEnvelope(save)).toThrow('invalid handState');
  });

  it.each([
    'activeGameIds',
    'currentHandGameIds',
    'currentHandOrigin',
    'lastDisplayedGameId',
    'gameInstances',
    'activeGameType',
    'handState',
    'channelStatus',
    'lastOutcomeWin',
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
  ] satisfies Array<keyof SessionPresentationSave>)(
    'rejects a v13 presentation missing required %s',
    (field) => {
      const save = liveSave();
      if (save.phase !== 'live') throw new Error('expected live fixture');
      Reflect.deleteProperty(save.presentation, field);
      expect(() => validateSessionSaveEnvelope(save)).toThrow();
    },
  );

  it.each([
    ['activeGameIds', { activeGameIds: ['game-1', 'game-1'] }],
    ['currentHandGameIds', { currentHandGameIds: ['game-1', 'game-1'] }],
  ])('rejects duplicate %s', (_label, fields) => {
    expect(() => validateSessionSaveEnvelope(activeSave(fields))).toThrow('duplicate');
  });

  it.each([
    ['active', { gameInstances: {} }],
    ['current', { activeGameIds: [], gameInstances: {} }],
    ['last display', { activeGameIds: [], currentHandGameIds: [], gameInstances: {} }],
  ])('rejects a missing %s instance', (_label, fields) => {
    expect(() => validateSessionSaveEnvelope(activeSave(fields))).toThrow('missing its keyed');
  });

  it('retains completed current-hand members but rejects active terminal members', () => {
    expect(() =>
      validateSessionSaveEnvelope(
        activeSave({
          activeGameIds: [],
          gameInstances: { 'game-1': TERMINAL_INSTANCE },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateSessionSaveEnvelope(activeSave({ gameInstances: { 'game-1': TERMINAL_INSTANCE } })),
    ).toThrow('active game game-1 is terminal');
  });

  it('requires presentation and terminal state to end together', () => {
    expect(() =>
      validateSessionSaveEnvelope(
        activeSave({
          activeGameIds: [],
          gameInstances: {
            'game-1': { ...TERMINAL_INSTANCE, presentation: 'finishing' },
          },
        }),
      ),
    ).toThrow('presentation and terminal state disagree');
    expect(() =>
      validateSessionSaveEnvelope(
        activeSave({
          activeGameIds: [],
          gameInstances: {
            'game-1': { ...ACTIVE_INSTANCE, presentation: 'ended' },
          },
        }),
      ),
    ).toThrow('presentation and terminal state disagree');
  });

  it('rejects mismatched hand types and unrelated Krunk payload IDs', () => {
    expect(() =>
      validateSessionSaveEnvelope(
        activeSave({
          handState: calpokerStateCodec.encode({
            playerHand: [1n, 2n],
            opponentHand: [3n, 4n],
            moveNumber: 1n,
            isPlayerTurn: true,
          }),
          activeGameType: 'spacepoker',
        }),
      ),
    ).toThrow('activeGameType does not match');

    expect(() =>
      validateSessionSaveEnvelope(
        activeSave({
          handState: krunkStateCodec.encode({
            games: { unrelated: initialKrunkGameState('alice') },
          }),
          activeGameType: 'krunk',
          betweenHandLastHandProposal: {
            my_contribution: '100',
            their_contribution: '100',
            game_timeout: '15',
            game_type: 'krunk',
          },
        }),
      ),
    ).toThrow('exactly match currentHandGameIds');
  });

  it('rejects a partial Krunk payload for the current pair', () => {
    const ids = ['game-1', 'game-2'];
    expect(() =>
      validateSessionSaveEnvelope(
        liveSave({
          activeGameIds: ids,
          currentHandGameIds: ids,
          currentHandOrigin: 'local',
          lastDisplayedGameId: ids[0],
          activeGameType: 'krunk',
          gameInstances: {
            'game-1': ACTIVE_INSTANCE,
            'game-2': { ...ACTIVE_INSTANCE, id: 'game-2' },
          },
          handState: krunkStateCodec.encode({
            games: { 'game-1': initialKrunkGameState('alice') },
          }),
          betweenHandLastHandProposal: {
            my_contribution: '100',
            their_contribution: '100',
            game_timeout: '15',
            game_type: 'krunk',
          },
        }),
      ),
    ).toThrow('exactly match currentHandGameIds');
  });

  it.each([
    [
      'calpoker',
      calpokerStateCodec.encode({
        playerHand: [1n, 2n],
        opponentHand: [3n, 4n],
        moveNumber: 1n,
        isPlayerTurn: true,
      }),
      {},
    ],
    [
      'spacepoker',
      spacepokerStateCodec.encode({
        gameState: { handler: 2n, myTurn: true, N: 4n },
        playerHoleCards: null,
        playerBoost: false,
        opponentHoleCards: null,
        opponentBoost: null,
        communityCards: [null, null, null, null, null],
        halfPot: 1n,
        lastRaise: 0n,
        iRaisedLast: false,
        handHistory: [],
        outcome: null,
        terminalState: 'none',
        terminalRecovery: null,
        pendingTerminalAction: null,
        coinTossIOpen: null,
        unitSizeMojos: 10n,
        displayMode: 'mojos',
      }),
      { spacepoker_unit_size: '10' },
    ],
  ] as const)('rejects multi-member %s singleton hands', (gameType, handState, extras) => {
    expect(() =>
      validateSessionSaveEnvelope(
        liveSave({
          activeGameIds: ['game-1', 'game-2'],
          currentHandGameIds: ['game-1', 'game-2'],
          currentHandOrigin: 'local',
          activeGameType: gameType,
          gameInstances: {
            'game-1': ACTIVE_INSTANCE,
            'game-2': { ...ACTIVE_INSTANCE, id: 'game-2' },
          },
          handState,
          betweenHandLastHandProposal: {
            my_contribution: '100',
            their_contribution: '100',
            game_timeout: '15',
            game_type: gameType,
            ...extras,
          },
        }),
      ),
    ).toThrow('exactly one currentHandGameId');
  });

  it.each([
    [['game-1'], { 'game-1': initialKrunkGameState('alice') }],
    [
      ['game-1', 'game-2', 'game-3'],
      {
        'game-1': initialKrunkGameState('alice'),
        'game-2': initialKrunkGameState('bob'),
        'game-3': initialKrunkGameState('alice'),
      },
    ],
  ])('rejects Krunk hands with invalid factory cardinality', (ids, games) => {
    expect(() =>
      validateSessionSaveEnvelope(
        liveSave({
          activeGameIds: ids,
          currentHandGameIds: ids,
          currentHandOrigin: 'local',
          lastDisplayedGameId: ids[0],
          activeGameType: 'krunk',
          gameInstances: Object.fromEntries(
            ids.map((id) => [id, { ...ACTIVE_INSTANCE, id, amount: '100' }]),
          ),
          handState: krunkStateCodec.encode({ games }),
          betweenHandLastHandProposal: {
            my_contribution: '100',
            their_contribution: '100',
            game_timeout: '15',
            game_type: 'krunk',
          },
        }),
      ),
    ).toThrow('exactly two ordered currentHandGameIds');
  });

  it('rejects missing, extra, and reordered Krunk payload IDs', () => {
    const ids = ['game-1', 'game-2'];
    const baseFields = {
      activeGameIds: ids,
      currentHandGameIds: ids,
      currentHandOrigin: 'local' as const,
      lastDisplayedGameId: ids[0],
      activeGameType: 'krunk' as const,
      gameInstances: {
        'game-1': { ...ACTIVE_INSTANCE, id: 'game-1', amount: '100' },
        'game-2': { ...ACTIVE_INSTANCE, id: 'game-2', amount: '100' },
      },
      betweenHandLastHandProposal: {
        my_contribution: '100',
        their_contribution: '100',
        game_timeout: '15',
        game_type: 'krunk',
      },
    };
    for (const games of [
      { 'game-1': initialKrunkGameState('alice') },
      {
        'game-1': initialKrunkGameState('alice'),
        'game-2': initialKrunkGameState('bob'),
        extra: initialKrunkGameState('alice'),
      },
      {
        'game-2': initialKrunkGameState('bob'),
        'game-1': initialKrunkGameState('alice'),
      },
    ]) {
      expect(() =>
        validateSessionSaveEnvelope(
          liveSave({ ...baseFields, handState: krunkStateCodec.encode({ games }) }),
        ),
      ).toThrow('exactly match currentHandGameIds in order');
    }
  });

  it('rejects unrelated keyed instances but retains a terminal display member', () => {
    expect(() =>
      validateSessionSaveEnvelope(
        activeSave({
          gameInstances: {
            'game-1': ACTIVE_INSTANCE,
            unrelated: { ...TERMINAL_INSTANCE, id: 'unrelated' },
          },
        }),
      ),
    ).toThrow('unrelated keyed instance');

    expect(() =>
      validateSessionSaveEnvelope(
        activeSave({
          activeGameIds: ['game-1'],
          currentHandGameIds: ['game-1'],
          lastDisplayedGameId: 'terminal',
          gameInstances: {
            'game-1': ACTIVE_INSTANCE,
            terminal: { ...TERMINAL_INSTANCE, id: 'terminal' },
          },
        }),
      ),
    ).not.toThrow();
  });

  it('accepts terminal frozen snapshots with or without remount state', () => {
    const terminal = baseSave({
      channelStatus: { state: 'ResolvedClean' },
      coinsOfInterest: [],
      activeGameIds: [],
      currentHandGameIds: ['game-1'],
      currentHandOrigin: 'peer',
      lastDisplayedGameId: 'game-1',
      activeGameType: 'calpoker',
      gameInstances: { 'game-1': TERMINAL_INSTANCE },
      betweenHandLastHandProposal: {
        my_contribution: '20',
        their_contribution: '20',
        game_timeout: '15',
        game_type: 'calpoker',
      },
    });
    expect(() => validateSessionSaveEnvelope(terminal)).not.toThrow();
    expect(() =>
      validateSessionSaveEnvelope(
        terminal.phase === 'terminal'
          ? {
              ...terminal,
              presentation: {
                ...terminal.presentation,
                handState: calpokerStateCodec.encode({
                  playerHand: [1n, 2n],
                  opponentHand: [3n, 4n],
                  moveNumber: 1n,
                  isPlayerTurn: false,
                }),
              },
            }
          : terminal,
      ),
    ).not.toThrow();
  });

  it('rejects persisted hands without matching game terms', () => {
    expect(() =>
      validateSessionSaveEnvelope(activeSave({ betweenHandLastHandProposal: null })),
    ).toThrow('betweenHandLastHandProposal');
    expect(() =>
      validateSessionSaveEnvelope(
        activeSave({
          activeGameType: 'spacepoker',
          handState: spacepokerStateCodec.encode({
            gameState: { handler: 2n, myTurn: true, N: 4n },
            playerHoleCards: [1n, 2n],
            playerBoost: false,
            opponentHoleCards: null,
            opponentBoost: null,
            communityCards: [null, null, null, null, null],
            halfPot: 1n,
            lastRaise: 0n,
            iRaisedLast: false,
            handHistory: [],
            outcome: null,
            terminalState: 'none',
            terminalRecovery: null,
            pendingTerminalAction: null,
            coinTossIOpen: true,
            unitSizeMojos: 10n,
            displayMode: 'mojos',
          }),
          betweenHandLastHandProposal: {
            my_contribution: '20',
            their_contribution: '20',
            game_timeout: '15',
            game_type: 'calpoker',
          },
        }),
      ),
    ).toThrow('activeGameType does not match betweenHandLastHandProposal.game_type');
  });

  it.each([
    undefined,
    [{ label: '', id: 'coin' }],
    [{ label: 'Coin', id: '' }],
    [
      { label: 'Coin A', id: 'same' },
      { label: 'Coin B', id: 'same' },
    ],
  ])('rejects invalid terminal coin lists', (coinsOfInterest) => {
    expect(() =>
      validateSessionSaveEnvelope(
        baseSave({
          channelStatus: { state: 'ResolvedClean' },
          coinsOfInterest,
        }),
      ),
    ).toThrow();
  });

  it.each([
    { ...TERMINAL_INSTANCE.terminal, outcome: null },
    {
      type: 'none',
      outcome: null,
      label: 'unexpected',
      myReward: null,
      rewardCoinHex: null,
    },
    {
      type: 'ended-cancelled',
      outcome: 'settled_cleanly',
      label: 'Cancelled',
      myReward: null,
      rewardCoinHex: null,
    },
    { ...TERMINAL_INSTANCE.terminal, myReward: 'not-an-amount' },
    {
      type: 'ended-cancelled',
      outcome: null,
      label: 'Cancelled',
      myReward: '1',
      rewardCoinHex: null,
    },
  ])('rejects malformed cross-field terminal outcomes', (terminal) => {
    expect(() =>
      validateSessionSaveEnvelope(
        activeSave({
          activeGameIds: [],
          gameInstances: {
            'game-1': { ...TERMINAL_INSTANCE, terminal },
          },
        }),
      ),
    ).toThrow();
  });

  it.each(['outcome', 'label', 'myReward', 'rewardCoinHex'] as const)(
    'rejects an omitted game terminal %s while accepting explicit null',
    (field) => {
      const omitted = structuredClone(activeSave());
      if (omitted.phase !== 'live') throw new Error('expected live fixture');
      Reflect.deleteProperty(omitted.presentation.gameInstances['game-1'].terminal, field);
      expect(() => validateSessionSaveEnvelope(omitted)).toThrow(`terminal.${field}`);

      expect(() => validateSessionSaveEnvelope(activeSave())).not.toThrow();
    },
  );

  it.each(['myAlias', 'opponentAlias'] as const)(
    'rejects an omitted terminal session %s while accepting explicit null',
    (field) => {
      const omitted = baseSave({
        channelStatus: { state: 'ResolvedClean' },
        coinsOfInterest: [],
      });
      if (omitted.phase !== 'terminal') throw new Error('expected terminal fixture');
      Reflect.deleteProperty(omitted.terminal, field);
      expect(() => validateSessionSaveEnvelope(omitted)).toThrow(`terminal.${field}`);

      expect(() =>
        validateSessionSaveEnvelope(
          baseSave({
            channelStatus: { state: 'ResolvedClean' },
            coinsOfInterest: [],
          }),
        ),
      ).not.toThrow();
    },
  );

  it.each([
    ['between-hand mode', { betweenHandMode: 'unknown-mode' }, 'betweenHandMode'],
    [
      'between-hand terms',
      {
        betweenHandLastHandProposal: {
          my_contribution: 'not-an-amount',
          their_contribution: '10',
          game_type: 'calpoker',
        },
      },
      'betweenHandLastHandProposal.my_contribution',
    ],
    [
      'peer proposal',
      {
        proposalGroups: [
          {
            primary_id: 'proposal-1',
            member_ids: [],
            origin: 'peer',
            disposition: 'incoming-cached',
            hand_proposal: {
              my_contribution: '10',
              their_contribution: '10',
              game_type: 'calpoker',
            },
          },
        ],
      },
      'member_ids',
    ],
    [
      'proposal groups',
      {
        proposalGroups: [
          {
            primary_id: 'proposal-1',
            member_ids: ['proposal-1', 'proposal-1'],
            origin: 'local',
            disposition: 'outgoing',
            hand_proposal: {
              my_contribution: '100',
              their_contribution: '100',
              game_type: 'krunk',
            },
          },
        ],
      },
      'duplicate',
    ],
    [
      'compose amount',
      {
        betweenHandCompose: {
          selected_game: 'calpoker',
          game_timeout: '15',
          proposal_sent: false,
          drafts: {
            calpoker: { amount: 'ten' },
            krunk: { amount: '100' },
            spacepoker: { unitSize: '1', stackSize: '10' },
          },
        },
      },
      'betweenHandCompose.drafts.calpoker.amount',
    ],
  ])('rejects malformed %s state', (_label, fields, message) => {
    expect(() => validateSessionSaveEnvelope(liveSave(fields as Partial<SessionSave>))).toThrow(
      message,
    );
  });

  it.each([
    ['channel discriminant', { channelStatus: { state: 'Bogus' } }, 'channelStatus.state'],
    [
      'channel balance',
      { channelStatus: { state: 'Active', our_balance: { Amount: 'nope' } } },
      'channelStatus.our_balance',
    ],
    [
      'notification kind',
      {
        channelNotifQueue: [{ id: 1n, kind: 'unknown', title: 'Title', message: 'Message' }],
      },
      'notification[0].kind',
    ],
    [
      'notification id',
      {
        gameNotifQueue: [
          { id: 'not-an-id', kind: 'game-terminal', title: 'Title', message: 'Message' },
        ],
      },
      'notification id',
    ],
    ['transport counter', { messageNumber: '1' }, 'messageNumber'],
    [
      'transport message payload',
      { unackedMessages: [{ msgno: 1n, msg: [1, 2, 3] }] },
      'unackedMessages[0].msg',
    ],
    ['cradle bytes', { serializedGameSession: [1, 2, 3] }, 'serializedGameSession'],
    ['timeout numeric string', { channelTimeout: '0' }, 'channelTimeout'],
  ])('rejects malformed %s metadata', (_label, fields, message) => {
    expect(() =>
      validateSessionSaveEnvelope(liveSave(fields as unknown as Partial<SessionSave>)),
    ).toThrow(message);
  });

  it('restores compose from the explicit complete snapshot rather than a per-game fallback', () => {
    const save = liveSave({
      betweenHandMode: 'decision',
      betweenHandCompose: {
        selected_game: 'calpoker',
        game_timeout: '20',
        proposal_sent: false,
        drafts: {
          calpoker: { amount: '12' },
          krunk: { amount: '100' },
          spacepoker: { unitSize: '1', stackSize: '20' },
        },
      },
      betweenHandLastHandProposal: {
        my_contribution: '12',
        their_contribution: '12',
        game_timeout: '20',
        game_type: 'calpoker',
      },
      channelNotifQueue: [{ id: 1n, kind: 'channel-state', title: 'Channel', message: 'Ready' }],
      myRunningBalance: '-3',
    });

    expect(() => validateSessionSaveEnvelope(save)).not.toThrow();
    expect(() => sessionModelFromSave(save)).not.toThrow();
    expect(sessionModelFromSave(save).betweenHand.compose.drafts.calpoker.amount).toBe(12n);
  });
});
