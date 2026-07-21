import {
  createSessionModel,
  snapshotFromSessionModel,
  sessionModelFromSave,
} from '../session/model';
import {
  selectFinishedSessionDisplay,
  sessionModelForReactProps,
} from '../session/finishedSessionDisplay';
import type { CalpokerHandState } from '../../hooks/save';
import type { SpacepokerHandState } from '../../hooks/useSpacepokerHand';
import { SpHandler } from '../../hooks/useSpacepokerHand';
import { KrunkHandler } from '../../hooks/useKrunkHand';
import { calpokerTimeoutBadge } from '../settlement';

describe('finished session Game tab freeze', () => {
  const calpokerHand: CalpokerHandState = {
    playerHand: [8n, 7n, 6n, 5n],
    opponentHand: [4n, 3n, 2n, 1n],
    moveNumber: 3n,
    isPlayerTurn: false,
    displaySnapshot: {
      gameState: 'FINAL',
      winner: 'player',
      playerBestHandCardIds: [8n, 7n, 6n, 5n],
      opponentBestHandCardIds: [4n, 3n, 2n, 1n],
      playerHaloCardIds: [8n, 7n],
      opponentHaloCardIds: [4n, 3n],
      playerDisplayText: 'Pair of eights',
      opponentDisplayText: 'High card',
    },
  };

  const spacepokerHand: SpacepokerHandState = {
    gameState: { handler: SpHandler.Folded, myTurn: false, N: 2n },
    playerHoleCards: [14n, 13n],
    playerBoost: false,
    opponentHoleCards: null,
    opponentBoost: null,
    communityCards: [2n, 3n, 4n, null, null],
    halfPot: 1n,
    lastRaise: 0n,
    iRaisedLast: false,
    handHistory: [{ player: 'you', action: 'raise', units: 1n }],
    outcome: null,
    terminalState: 'folded-by-you',
    settlementOutcome: 'timed_out_waiting_for_our_move',
    coinTossIOpen: true,
    unitSizeMojos: 100n,
    displayMode: 'mojos',
  };

  it('selects a calpoker board freeze from handState + terminal (not empty placeholder)', () => {
    const model = createSessionModel({
      game: {
        activeGameType: 'calpoker',
        handState: {
          gameType: 'calpoker',
          version: 1n,
          state: calpokerHand,
        },
        terminal: {
          type: 'settled',
          outcome: 'opponent_timed_out',
          label: 'Opponent timed out',
          myReward: '200',
          rewardCoinHex: null,
        },
      },
    });

    const display = selectFinishedSessionDisplay(model);
    expect(display.canRemountHand).toBe(true);
    expect(display.hasCalpokerBoard).toBe(true);
    expect(display.terminalLabel).toBe('Opponent timed out');
    expect(display.calpoker?.displaySnapshot?.playerDisplayText).toBe('Pair of eights');
  });

  it('selects a spacepoker board freeze from handState (not empty placeholder)', () => {
    const model = createSessionModel({
      game: {
        activeGameType: 'spacepoker',
        handState: {
          gameType: 'spacepoker',
          version: 1n,
          state: spacepokerHand,
        },
        terminal: {
          type: 'settled',
          outcome: 'timed_out_waiting_for_our_move',
          label: 'Timed out waiting for our move',
          myReward: '0',
          rewardCoinHex: null,
        },
      },
    });

    const display = selectFinishedSessionDisplay(model);
    expect(display.canRemountHand).toBe(true);
    expect(display.hasSpacepokerBoard).toBe(true);
    expect(display.hasCalpokerBoard).toBe(false);
    expect(display.spacepoker?.settlementOutcome).toBe('timed_out_waiting_for_our_move');
    expect(display.spacepoker?.terminalState).toBe('folded-by-you');
  });

  it('selects persisted terminal Krunk state for reload recovery', () => {
    const krunkHand = {
      games: {
        alice: {
          handler: BigInt(KrunkHandler.Terminal),
          myTurn: false,
          role: 'alice',
          guesses: [],
          secretWord: 'CRANE',
          revealedWord: 'CRANE',
          outcome: 'lose',
          moverShare: '0',
          settlementOutcome: 'opponent_timed_out',
          error: null,
        },
      },
    };
    const model = createSessionModel({
      game: {
        activeGameType: 'krunk',
        handState: {
          gameType: 'krunk',
          version: 1n,
          state: krunkHand,
        },
        terminal: {
          type: 'settled',
          outcome: 'opponent_timed_out',
          label: 'Opponent timed out',
          myReward: '200',
          rewardCoinHex: null,
        },
      },
    });

    const display = selectFinishedSessionDisplay(model);
    expect(display.canRemountHand).toBe(true);
    expect(display.terminalLabel).toBe('Opponent timed out');
  });

  it('falls back to terminal summary when hand cards/snapshot are missing', () => {
    const model = createSessionModel({
      game: {
        activeGameType: 'calpoker',
        handState: null,
        terminal: {
          type: 'settled',
          outcome: 'settled_cleanly',
          label: 'Settled cleanly',
          myReward: '50',
          rewardCoinHex: null,
        },
      },
    });

    const display = selectFinishedSessionDisplay(model);
    expect(display.canRemountHand).toBe(false);
    expect(display.hasCalpokerBoard).toBe(false);
    expect(display.terminalLabel).toBe('Settled cleanly');
  });

  it('hides handState from enumerable React props (bigint arrays break JSON.stringify)', () => {
    const model = createSessionModel({
      game: {
        activeGameType: 'spacepoker',
        handState: {
          gameType: 'spacepoker',
          version: 1n,
          state: spacepokerHand,
        },
      },
    });
    const propSafe = sessionModelForReactProps(model);
    expect(propSafe.game.handState?.gameType).toBe('spacepoker');
    expect(Object.keys(propSafe.game)).not.toContain('handState');
    expect(() => JSON.stringify(propSafe.game)).not.toThrow();
  });

  it('remounts calpoker from card arrays alone (timeout mid-hand has no displaySnapshot)', () => {
    const model = createSessionModel({
      game: {
        activeGameType: 'calpoker',
        handState: {
          gameType: 'calpoker',
          version: 1n,
          state: {
            playerHand: [8n, 7n, 6n, 5n],
            opponentHand: [4n, 3n, 2n, 1n],
            moveNumber: 1n,
            isPlayerTurn: true,
            settlementOutcome: 'timed_out_waiting_for_our_move',
            // no displaySnapshot — CaliforniaPoker must not dealCards on remount
          },
        },
        terminal: {
          type: 'settled',
          outcome: 'timed_out_waiting_for_our_move',
          label: 'Timed out waiting for our move',
          myReward: '0',
          rewardCoinHex: null,
        },
      },
    });

    const display = selectFinishedSessionDisplay(model);
    expect(display.hasCalpokerBoard).toBe(true);
    expect(display.canRemountHand).toBe(true);
    expect(display.calpoker?.settlementOutcome).toBe('timed_out_waiting_for_our_move');
  });

  it('remounts spacepoker with settlementOutcome for Timed Out badges after resolve', () => {
    const model = createSessionModel({
      game: {
        activeGameType: 'spacepoker',
        handState: {
          gameType: 'spacepoker',
          version: 1n,
          state: {
            ...spacepokerHand,
            terminalState: 'folded-by-you',
            settlementOutcome: 'timed_out_waiting_for_our_move',
          },
        },
        terminal: {
          type: 'settled',
          outcome: 'timed_out_waiting_for_our_move',
          label: 'Timed out waiting for our move',
          myReward: '0',
          rewardCoinHex: null,
        },
      },
    });

    const display = selectFinishedSessionDisplay(model);
    expect(display.canRemountHand).toBe(true);
    expect(display.spacepoker?.settlementOutcome).toBe('timed_out_waiting_for_our_move');
    expect(calpokerTimeoutBadge(display.spacepoker!.settlementOutcome!, 'ours')).toBe('timeout');
  });

  it('rejects calpoker handState with wrong persisted version', () => {
    const model = createSessionModel({
      game: {
        activeGameType: 'calpoker',
        handState: {
          gameType: 'calpoker',
          version: 99n,
          state: calpokerHand,
        },
        terminal: {
          type: 'settled',
          outcome: 'settled_cleanly',
          label: 'Settled cleanly',
          myReward: '50',
          rewardCoinHex: null,
        },
      },
    });

    const display = selectFinishedSessionDisplay(model);
    expect(display.calpoker).toBeUndefined();
    expect(display.hasCalpokerBoard).toBe(false);
    expect(display.canRemountHand).toBe(false);
  });

  it('maps spacepoker timeout settlements to Timed Out badges (not Fold)', () => {
    expect(calpokerTimeoutBadge('timed_out_waiting_for_our_move', 'ours')).toBe('timeout');
    expect(calpokerTimeoutBadge('timed_out_waiting_for_our_move', 'theirs')).toBe('winner');
    expect(calpokerTimeoutBadge('opponent_timed_out', 'ours')).toBe('winner');
    expect(calpokerTimeoutBadge('opponent_timed_out', 'theirs')).toBe('timeout');
  });

  it('includes handState and terminal fields in resolved freeze snapshots', () => {
    const model = createSessionModel({
      game: {
        activeGameType: 'spacepoker',
        handState: {
          gameType: 'spacepoker',
          version: 1n,
          state: spacepokerHand,
        },
        terminal: {
          type: 'settled',
          outcome: 'timed_out_waiting_for_our_move',
          label: 'Timed out waiting for our move',
          myReward: '0',
          rewardCoinHex: 'deadbeef',
        },
      },
    });

    const snapshot = snapshotFromSessionModel(model);
    expect(snapshot.activeGameType).toBe('spacepoker');
    expect(snapshot.handState?.gameType).toBe('spacepoker');
    expect((snapshot.handState?.state as SpacepokerHandState).settlementOutcome)
      .toBe('timed_out_waiting_for_our_move');
    expect(snapshot.gameTerminalOutcome).toBe('timed_out_waiting_for_our_move');

    const restored = sessionModelFromSave({
      version: 8n,
      playerId: 'p1',
      activeGameIds: [],
      activeGameType: snapshot.activeGameType,
      handState: snapshot.handState,
      gameTerminalType: snapshot.gameTerminalType,
      gameTerminalOutcome: snapshot.gameTerminalOutcome,
      gameTerminalLabel: snapshot.gameTerminalLabel,
      gameTerminalReward: snapshot.gameTerminalReward,
      gameTerminalRewardCoin: snapshot.gameTerminalRewardCoin,
      channelStatus: {
        state: 'ResolvedUnrolled',
        advisory: null,
        coin: null,
        our_balance: '0',
        their_balance: '200',
        game_allocated: '0',
        have_potato: false,
      },
    });

    const restoredDisplay = selectFinishedSessionDisplay(restored);
    expect(restoredDisplay.canRemountHand).toBe(true);
    expect(restoredDisplay.hasSpacepokerBoard).toBe(true);
    expect(restoredDisplay.spacepoker?.playerHoleCards).toEqual([14n, 13n]);
  });
});
