import { calpokerStateCodec } from '@games/calpoker/ui/serialize';
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
        player_a_contribution: '20',
        player_b_contribution: '20',
        sender_is_player_a: false,
        game_timeout: '15',
        game_type: 'calpoker',
        parameters: null,
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
    'pendingCandidates',
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

  it('rejects only a generic hand-envelope game type mismatch', () => {
    expect(() =>
      validateSessionSaveEnvelope(
        activeSave({
          handState: calpokerStateCodec.encode({
            playerHand: [1n, 2n],
            opponentHand: [3n, 4n],
            moveNumber: 1n,
            isPlayerTurn: true,
            iStarted: true,
            error: null,
          }),
          activeGameType: 'spacepoker',
        }),
      ),
    ).toThrow('activeGameType does not match');
  });

  it('validates pending candidate envelope fields while keeping game state opaque', () => {
    const base = activeSave();
    if (base.phase !== 'live') throw new Error('expected live fixture');
    const state = calpokerStateCodec.decode(base.presentation.handState)!;
    expect(() =>
      validateSessionSaveEnvelope(
        activeSave({
          pendingCandidates: [{ gameType: 'calpoker', id: 'game-1', action: 'make_move', state }],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateSessionSaveEnvelope(
        activeSave({
          pendingCandidates: [
            { gameType: 'calpoker', id: 'game-1', action: 'make_move', state: {} },
          ],
        }),
      ),
    ).not.toThrow();
    for (const pendingCandidates of [
      [
        { gameType: 'calpoker', id: 'game-1', action: 'make_move', state },
        { gameType: 'calpoker', id: 'game-1', action: 'cheat', state },
      ],
      [{ gameType: 'calpoker', id: 'other', action: 'make_move', state }],
      [{ gameType: 'calpoker', id: 'game-1', action: 'unknown', state }],
      [{ gameType: 'spacepoker', id: 'game-1', action: 'make_move', state }],
    ]) {
      expect(() => validateSessionSaveEnvelope(activeSave({ pendingCandidates }))).toThrow();
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
        player_a_contribution: '20',
        player_b_contribution: '20',
        sender_is_player_a: false,
        game_timeout: '15',
        game_type: 'calpoker',
        parameters: null,
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
                  iStarted: false,
                  error: null,
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
            coinTossIOpen: true,
            unitSizeMojos: 10n,
            displayMode: 'mojos',
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
          player_a_contribution: 'not-an-amount',
          player_b_contribution: '10',
          sender_is_player_a: false,
          game_timeout: '15',
          game_type: 'calpoker',
          parameters: null,
        },
      },
      'betweenHandLastHandProposal.player_a_contribution',
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
              player_a_contribution: '10',
              player_b_contribution: '10',
              sender_is_player_a: false,
              game_timeout: '15',
              game_type: 'calpoker',
              parameters: null,
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
              player_a_contribution: '100',
              player_b_contribution: '100',
              sender_is_player_a: true,
              game_timeout: '15',
              game_type: 'krunk',
              parameters: null,
            },
          },
        ],
      },
      'duplicate',
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
          { id: 'not-an-id', kind: 'proposal-rejected', title: 'Title', message: 'Message' },
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

  it('restores only host-owned compose state', () => {
    const save = liveSave({
      betweenHandMode: 'decision',
      betweenHandCompose: {
        selected_game: 'calpoker',
        game_timeout: '20',
        proposal_sent: false,
      },
      betweenHandLastHandProposal: {
        player_a_contribution: '12',
        player_b_contribution: '12',
        sender_is_player_a: false,
        game_timeout: '20',
        game_type: 'calpoker',
        parameters: null,
      },
      channelNotifQueue: [{ id: 1n, kind: 'channel-state', title: 'Channel', message: 'Ready' }],
      myRunningBalance: '-3',
    });

    expect(() => validateSessionSaveEnvelope(save)).not.toThrow();
    expect(() => sessionModelFromSave(save)).not.toThrow();
    expect(sessionModelFromSave(save).betweenHand.compose).toEqual({
      selectedGame: 'calpoker',
      gameTimeout: 20n,
      proposalSent: false,
    });
  });
});
