import {
  createSessionModel,
  snapshotFromSessionModel,
  sessionModelFromSave,
} from '../session/model';
import { selectFinishedSessionDisplay } from '../session/finishedSessionDisplay';
import type { CalpokerHandState } from '../../hooks/save';

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
    expect(display.banner).toBe('Session finished');
    expect(display.hasCalpokerBoard).toBe(true);
    expect(display.terminalLabel).toBe('Opponent timed out');
    expect(display.terminalReward).toBe('200');
    expect(display.calpoker?.displaySnapshot?.playerDisplayText).toBe('Pair of eights');
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
    expect(display.hasCalpokerBoard).toBe(false);
    expect(display.banner).toBe('Session finished');
    expect(display.terminalLabel).toBe('Settled cleanly');
  });

  it('includes handState and terminal fields in resolved freeze snapshots', () => {
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
          rewardCoinHex: 'deadbeef',
        },
      },
    });

    const snapshot = snapshotFromSessionModel(model);
    expect(snapshot.activeGameType).toBe('calpoker');
    expect(snapshot.handState?.gameType).toBe('calpoker');
    expect((snapshot.handState?.state as CalpokerHandState).displaySnapshot?.playerDisplayText)
      .toBe('Pair of eights');
    expect(snapshot.gameTerminalType).toBe('settled');
    expect(snapshot.gameTerminalOutcome).toBe('opponent_timed_out');
    expect(snapshot.gameTerminalLabel).toBe('Opponent timed out');
    expect(snapshot.gameTerminalReward).toBe('200');

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
        our_balance: '200',
        their_balance: '0',
        game_allocated: '0',
        have_potato: false,
      },
    });

    const restoredDisplay = selectFinishedSessionDisplay(restored);
    expect(restoredDisplay.hasCalpokerBoard).toBe(true);
    expect(restoredDisplay.terminalLabel).toBe('Opponent timed out');
    expect(restoredDisplay.calpoker?.playerHand).toEqual([8n, 7n, 6n, 5n]);
  });
});
