import {
  initialShellSessionState,
  shellSessionReducer,
  type ShellSessionState,
} from '../session/shellSessionState';

describe('shellSessionReducer', () => {
  it('returns the initial state', () => {
    expect(initialShellSessionState).toEqual({
      sessionConfig: null,
      peerConn: null,
      dashboardSessionModel: null,
      sessionPhase: 'none',
      pendingAdvisory: null,
      pendingProposal: null,
      sessionError: false,
      restoreStatus: 'idle',
      restoreError: null,
      restoreHubReconciled: false,
      transition: { kind: 'idle' },
    });
  });

  it('sets lifecycle fields individually', () => {
    const state = shellSessionReducer(initialShellSessionState, {
      type: 'setSessionPhase',
      value: 'off-chain',
    });
    expect(state.sessionPhase).toBe('off-chain');
    expect(state.transition).toEqual({ kind: 'idle' });
  });

  it('enters and leaves a transition', () => {
    const pending = shellSessionReducer(initialShellSessionState, {
      type: 'startTransition',
      reason: 'accept-advisory',
      scope: 'session-pane',
      readyKey: null,
    });
    expect(pending.transition).toEqual({
      kind: 'pending',
      reason: 'accept-advisory',
      scope: 'session-pane',
      readyKey: null,
    });

    const ended = shellSessionReducer(pending, { type: 'endTransition' });
    expect(ended.transition).toEqual({ kind: 'idle' });
  });

  it('records the last transition reason', () => {
    const state = shellSessionReducer(initialShellSessionState, {
      type: 'startTransition',
      reason: 'resume',
      scope: 'shell',
      readyKey: null,
    });
    expect(state.transition).toEqual({
      kind: 'pending',
      reason: 'resume',
      scope: 'shell',
      readyKey: null,
    });
  });

  it('clears the consent prompt while a transition is pending', () => {
    const withAdvisory: ShellSessionState = {
      ...initialShellSessionState,
      pendingAdvisory: {
        peer_id: 'peer-1',
        peer_alias: 'Alice',
        my_amount: '100',
        their_amount: '100',
      },
    };

    const state = shellSessionReducer(withAdvisory, {
      type: 'startTransition',
      reason: 'accept-advisory',
      scope: 'session-pane',
      readyKey: null,
    });
    const cleared = shellSessionReducer(state, {
      type: 'setPendingAdvisory',
      value: null,
    });

    expect(cleared.transition).toEqual({
      kind: 'pending',
      reason: 'accept-advisory',
      scope: 'session-pane',
      readyKey: null,
    });
    expect(cleared.pendingAdvisory).toBeNull();
  });

  it('installs the new session snapshot before ending the transition', () => {
    let state = shellSessionReducer(initialShellSessionState, {
      type: 'startTransition',
      reason: 'accept-proposal',
      scope: 'session-pane',
      readyKey: null,
    });

    state = shellSessionReducer(state, {
      type: 'setSessionConfig',
      value: {
        iStarted: false,
        myContribution: 100n,
        theirContribution: 100n,
        perGameAmount: 10n,
        pairingToken: 'token-1',
      },
    });
    state = shellSessionReducer(state, {
      type: 'setSessionPhase',
      value: 'none',
    });
    state = shellSessionReducer(state, { type: 'endTransition' });

    expect(state.transition).toEqual({ kind: 'idle' });
    expect(state.sessionConfig).toEqual({
      iStarted: false,
      myContribution: 100n,
      theirContribution: 100n,
      perGameAmount: 10n,
      pairingToken: 'token-1',
    });
    expect(state.sessionPhase).toBe('none');
  });

  it('releases a waiting transition only for its registered session', () => {
    const state = shellSessionReducer(initialShellSessionState, {
      type: 'startTransition',
      reason: 'accept-advisory',
      scope: 'session-pane',
      readyKey: 'new-session',
    });

    expect(
      shellSessionReducer(state, {
        type: 'completeTransition',
        readyKey: 'old-session',
      }).transition,
    ).toEqual({
      kind: 'pending',
      reason: 'accept-advisory',
      scope: 'session-pane',
      readyKey: 'new-session',
    });

    expect(
      shellSessionReducer(state, {
        type: 'completeTransition',
        readyKey: 'new-session',
      }).transition,
    ).toEqual({ kind: 'idle' });
  });
});
