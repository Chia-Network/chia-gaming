import {
  initialShellSessionState,
  isAcceptSessionTransition,
  peerConnectionForSavedSession,
  shellSessionReducer,
  type ShellSessionState,
} from '../session/shellSessionState';
import { activeSave } from './session_save_envelope.fixtures';

describe('shellSessionReducer', () => {
  it('identifies accept transitions', () => {
    expect(isAcceptSessionTransition({ kind: 'idle' })).toBe(false);
    expect(
      isAcceptSessionTransition({
        kind: 'pending',
        reason: 'accept-advisory',
        scope: 'session-pane',
        readyKey: 't',
      }),
    ).toBe(true);
    expect(
      isAcceptSessionTransition({
        kind: 'pending',
        reason: 'accept-proposal',
        scope: 'session-pane',
        readyKey: 't',
      }),
    ).toBe(true);
  });

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

  it('beginAccept clears consent prompts atomically with the transition', () => {
    const withAdvisory: ShellSessionState = {
      ...initialShellSessionState,
      pendingAdvisory: {
        peer_id: 'peer-1',
        peer_alias: 'Alice',
        my_amount: '100',
        their_amount: '100',
      },
      pendingProposal: {
        from_id: 'peer-2',
        from_alias: 'Bob',
        proposer_amount: '50',
        responder_amount: '50',
      },
    };

    const state = shellSessionReducer(withAdvisory, {
      type: 'beginAccept',
      reason: 'accept-advisory',
      readyKey: 'token-1',
    });

    expect(state.transition).toEqual({
      kind: 'pending',
      reason: 'accept-advisory',
      scope: 'session-pane',
      readyKey: 'token-1',
    });
    expect(state.pendingAdvisory).toBeNull();
    expect(state.pendingProposal).toBeNull();
  });

  it('liveMounted installs session config and peer connection together', () => {
    const state = shellSessionReducer(initialShellSessionState, {
      type: 'liveMounted',
      sessionConfig: {
        iStarted: false,
        myContribution: 100n,
        theirContribution: 100n,
        perGameAmount: 10n,
        pairingToken: 'token-1',
      },
      peerConn: { send: () => {}, close: () => {} } as never,
    });
    expect(state.sessionConfig?.pairingToken).toBe('token-1');
    expect(state.peerConn).not.toBeNull();
  });

  it('provides persisted reliable identity before the hub peer reconnects', () => {
    const save = activeSave({
      gameSessionId: 'ab'.repeat(16),
      messageNumber: 7n,
      remoteNumber: 5n,
      unackedMessages: [{ msgno: 6n, msg: new Uint8Array([1, 2, 3]) }],
    });
    if (save.phase !== 'live') throw new Error('expected live save fixture');
    const idleConnection = {
      sendMessage: () => false,
      sendAck: () => false,
      sendKeepalive: () => false,
      hostLog: () => {},
      close: () => {},
    };

    const connection = peerConnectionForSavedSession(idleConnection, save);

    expect(connection.reliableState).toEqual({
      sessionId: 'ab'.repeat(16),
      messageNumber: 7n,
      remoteNumber: 5n,
      unackedMessages: [{ msgno: 6n, msg: new Uint8Array([1, 2, 3]) }],
      disposition: 'active',
    });
    expect(connection.reliableState?.unackedMessages).not.toBe(save.live.unackedMessages);
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

  it('acceptAborted clears consent, sets error, and ends the transition atomically', () => {
    const withConsent: ShellSessionState = {
      ...initialShellSessionState,
      pendingAdvisory: {
        peer_id: 'peer-1',
        peer_alias: 'Alice',
        my_amount: '100',
        their_amount: '100',
      },
      transition: {
        kind: 'pending',
        reason: 'accept-proposal',
        scope: 'session-pane',
        readyKey: 'token-1',
      },
    };

    const state = shellSessionReducer(withConsent, {
      type: 'acceptAborted',
      error: true,
    });
    expect(state.pendingAdvisory).toBeNull();
    expect(state.pendingProposal).toBeNull();
    expect(state.sessionError).toBe(true);
    expect(state.transition).toEqual({ kind: 'idle' });
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
