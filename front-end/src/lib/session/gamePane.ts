/**
 * Game-tab pane discriminant derived from Accept / mount / terminal state.
 * Replaces the ad-hoc predicate ladder in Shell's game tab.
 */

export type GamePaneKind =
  | { kind: 'transitionCover' }
  | { kind: 'restoreFailed'; error: string | null }
  | { kind: 'gameSession'; showTransitionSurface: boolean }
  | { kind: 'finishedFreeze' }
  | { kind: 'restoringPlaceholder' }
  | { kind: 'empty' };

export function selectGamePaneKind(input: {
  sessionPaneTransition: boolean;
  keepSession: boolean;
  restoreStatus: string;
  restoreError: string | null;
  sessionPhase: string;
  hasDashboardModel: boolean;
  sessionCanMount: boolean;
}): GamePaneKind {
  const {
    sessionPaneTransition,
    keepSession,
    restoreStatus,
    restoreError,
    sessionPhase,
    hasDashboardModel,
    sessionCanMount,
  } = input;

  // Shell owns the cover only before GameSession is kept; once mounted,
  // GameSession hosts SessionTransitionSurface under its notification stack.
  if (sessionPaneTransition && !keepSession) {
    return { kind: 'transitionCover' };
  }
  if (keepSession && restoreStatus === 'failed') {
    return { kind: 'restoreFailed', error: restoreError };
  }
  if (keepSession) {
    return { kind: 'gameSession', showTransitionSurface: sessionPaneTransition };
  }
  // Prefer finished freeze over sessionCanMount+"Restoring session...".
  // After live terminal finalization, sessionConfig/peerConn often remain
  // (warm GameSession path); if keepSession drops, we must not claim restore.
  if (sessionPhase === 'resolved' && hasDashboardModel) {
    return { kind: 'finishedFreeze' };
  }
  if (sessionCanMount) {
    return { kind: 'restoringPlaceholder' };
  }
  return { kind: 'empty' };
}
