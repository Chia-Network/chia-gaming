import {
  createSessionModel,
  INITIAL_CHANNEL_STATUS_MODEL,
  selectGameDashboardView,
} from '../session/model';
import type { SettlementOutcome } from '../settlement';
import {
  parseGameStatusTerminalInfo,
  terminalInfoFromGameSettled,
} from '../session/gameSessionEvents';
import { gameplayEventForSettlement } from '../wasm/gameplayEvents';

function keyedTerminalGame(
  outcome: SettlementOutcome,
  label: string,
  myReward: string,
  active = false,
) {
  return {
    activeIds: active ? ['7'] : [],
    currentHandIds: ['7'],
    instances: {
      '7': {
        id: '7',
        amount: '20',
        coin: { coinHex: null, turnState: 'ended' as const },
        handStatus: 'ended' as const,
        terminal: {
          type: 'settled' as const,
          outcome,
          label,
          myReward,
          rewardCoinHex: null,
        },
      },
    },
    lastDisplayedId: '7',
  };
}

describe('terminal session model', () => {
  it('shows a premature opponent timeout as an explicit ended detail', () => {
    const view = selectGameDashboardView(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' } },
        game: keyedTerminalGame('opponent_timed_out', 'Opponent timed out', '20'),
      }),
    );

    expect(view.handStatusLabel).toBe('Ended');
    expect(view.handDetail).toBe('Opponent timed out');
  });

  it('keeps each timeout side’s ended detail distinct', () => {
    const timedOut = selectGameDashboardView(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' } },
        game: keyedTerminalGame(
          'timed_out_waiting_for_our_move',
          'Timed out waiting for our move',
          '0',
        ),
      }),
    );

    expect(timedOut.handStatusLabel).toBe('Ended');
    expect(timedOut.handDetail).toBe('Timed out waiting for our move');
  });

  it('shows settled cleanly as an ended detail', () => {
    const view = selectGameDashboardView(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' } },
        game: keyedTerminalGame('settled_cleanly', 'Settled cleanly', '20'),
      }),
    );

    expect(view.handStatusLabel).toBe('Ended');
    expect(view.handDetail).toBe('Settled cleanly');
  });

  it('shows move-too-late as an ended detail distinct from forfeit', () => {
    const view = selectGameDashboardView(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' } },
        game: keyedTerminalGame('attempt_to_move_failed', 'Attempt to move failed', '0'),
      }),
    );

    expect(view.handStatusLabel).toBe('Ended');
    expect(view.handDetail).toBe('Attempt to move failed');
  });

  it('parses GameSettled into glossary labels without session-level Folded', () => {
    expect(
      terminalInfoFromGameSettled(
        {
          id: '7',
          outcome: 'accept_settlement',
          our_share: { Amount: 0 },
          coin_id: null,
        },
        null,
      ),
    ).toMatchObject({
      type: 'settled',
      outcome: 'accept_settlement',
      label: 'Accepted',
      myReward: '0',
    });

    expect(
      terminalInfoFromGameSettled(
        {
          id: '7',
          outcome: 'opponent_timed_out',
          our_share: '20',
          coin_id: null,
        },
        null,
      ),
    ).toMatchObject({
      type: 'settled',
      outcome: 'opponent_timed_out',
      label: 'Opponent timed out',
    });

    expect(
      terminalInfoFromGameSettled(
        {
          id: '7',
          outcome: 'attempt_to_move_failed',
          our_share: '0',
          coin_id: null,
        },
        null,
      ),
    ).toMatchObject({
      label: 'Attempt to move failed',
    });

    expect(
      gameplayEventForSettlement(
        '7',
        terminalInfoFromGameSettled(
          {
            id: '7',
            outcome: 'settled_cleanly',
            our_share: '20',
          },
          null,
        ),
      ),
    ).toEqual({
      Settled: { gameId: '7', outcome: 'settled_cleanly', ourShare: '20' },
    });
  });

  it('keeps cancelled/error GameStatus terminals separate from settlement', () => {
    expect(
      parseGameStatusTerminalInfo(
        {
          id: '7',
          status: 'ended-cancelled',
          my_reward: null,
          coin_id: null,
          reason: null,
          other_params: null,
        },
        null,
        'my-turn',
      ),
    ).toMatchObject({
      type: 'ended-cancelled',
      label: 'Cancelled',
    });

    expect(
      parseGameStatusTerminalInfo(
        {
          id: '7',
          status: 'ended-error',
          reason: 'boom',
          other_params: null,
        },
        null,
        'my-turn',
      ),
    ).toMatchObject({
      type: 'game-error',
      label: 'boom',
    });
  });

  it('prefers terminal hand state over stale on-chain turn state', () => {
    const view = selectGameDashboardView(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Unrolling' } },
        game: keyedTerminalGame('forfeited_skipped_reveal', 'Forfeited', '20', true),
      }),
    );

    expect(view.handStatusLabel).toBe('Ended');
    expect(view.handDetail).toBe('Forfeited');
  });
});
