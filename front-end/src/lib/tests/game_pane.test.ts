import { selectGamePaneKind } from '../session/gamePane';

describe('selectGamePaneKind', () => {
  const base = {
    sessionPaneTransition: false,
    keepSession: false,
    restoreStatus: 'idle',
    restoreError: null as string | null,
    sessionPhase: 'none',
    hasDashboardModel: false,
    sessionCanMount: false,
  };

  it('gives Shell the cover only before GameSession is kept', () => {
    expect(
      selectGamePaneKind({ ...base, sessionPaneTransition: true, keepSession: false }),
    ).toEqual({ kind: 'transitionCover' });
    expect(selectGamePaneKind({ ...base, sessionPaneTransition: true, keepSession: true })).toEqual(
      { kind: 'gameSession', showTransitionSurface: true },
    );
  });

  it('prefers finished freeze over restoring placeholder', () => {
    expect(
      selectGamePaneKind({
        ...base,
        sessionPhase: 'resolved',
        hasDashboardModel: true,
        sessionCanMount: true,
      }),
    ).toEqual({ kind: 'finishedFreeze' });
  });
});
