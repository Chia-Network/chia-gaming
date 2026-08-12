import {
  ACCEPT_SETUP_CANCEL_CHANNEL_STATES,
  persistFreshStartCheckpoint,
  shouldCompleteAcceptTransition,
  shouldSynthesizeSetupPending,
  startFailureDisposition,
  type FreshStartCheckpoint,
  type TerminalSessionBackup,
} from '../session/acceptLifecycle';
import type { SessionModel } from '../session/types';
import type { ChannelStatus } from '../../types/ChiaGaming';

function modelWithChannelState(state: ChannelStatus): SessionModel {
  return {
    channel: {
      status: {
        state,
        sessionDisposition: undefined,
      },
    },
  } as SessionModel;
}

describe('acceptLifecycle', () => {
  describe('startFailureDisposition', () => {
    it('abandons the peer attempt only when persist has not committed', () => {
      expect(startFailureDisposition(false)).toBe('abandon-peer-only');
    });

    it('cancels the full attempt once replaceSession has landed', () => {
      expect(startFailureDisposition(true)).toBe('cancel-attempt');
    });
  });

  describe('shouldSynthesizeSetupPending', () => {
    it('limits synthesis to the pre-first-model / finished-freeze window', () => {
      expect(shouldSynthesizeSetupPending(false, false)).toBe(false);
      expect(shouldSynthesizeSetupPending(true, false)).toBe(true);
      expect(shouldSynthesizeSetupPending(true, true)).toBe(false);
    });
  });

  describe('shouldCompleteAcceptTransition', () => {
    it('stays pending through Cancel-only setup channel states', () => {
      for (const state of ACCEPT_SETUP_CANCEL_CHANNEL_STATES) {
        expect(shouldCompleteAcceptTransition(modelWithChannelState(state))).toBe(false);
      }
    });

    it('completes once the channel leaves Cancel-only setup', () => {
      expect(shouldCompleteAcceptTransition(modelWithChannelState('OfferSent'))).toBe(true);
      expect(shouldCompleteAcceptTransition(modelWithChannelState('Active'))).toBe(true);
    });
  });

  describe('persistFreshStartCheckpoint', () => {
    const checkpoint: FreshStartCheckpoint = {
      pairing: {
        token: 't1',
        peerId: 'peer',
        gameSessionId: 'gs',
        iStarted: true,
        myContribution: '10',
        theirContribution: '10',
        perGameAmount: '1',
      },
    };

    it('skips the write when the start epoch already advanced', async () => {
      const replaceSession = jest.fn();
      await persistFreshStartCheckpoint({
        epoch: 1,
        getCurrentEpoch: () => 2,
        loadState: () =>
          ({ phase: 'none' }) as ReturnType<
            Parameters<typeof persistFreshStartCheckpoint>[0]['loadState']
          >,
        replaceSession,
        saveTerminalSession: jest.fn(),
        clearSessionPreservingHistory: jest.fn(),
        checkpoint,
        onCommitted: jest.fn(),
      });
      expect(replaceSession).not.toHaveBeenCalled();
    });

    it('marks committed after a successful write that is still current', async () => {
      const onCommitted = jest.fn();
      const replaceSession = jest.fn().mockResolvedValue(undefined);
      await persistFreshStartCheckpoint({
        epoch: 3,
        getCurrentEpoch: () => 3,
        loadState: () =>
          ({ phase: 'none' }) as ReturnType<
            Parameters<typeof persistFreshStartCheckpoint>[0]['loadState']
          >,
        replaceSession,
        saveTerminalSession: jest.fn(),
        clearSessionPreservingHistory: jest.fn(),
        checkpoint,
        onCommitted,
      });
      expect(replaceSession).toHaveBeenCalledWith(checkpoint);
      expect(onCommitted).toHaveBeenCalled();
    });

    it('marks committed once replaceSession lands, including Cancel-race restore', async () => {
      let epoch = 5;
      const terminalBackup: NonNullable<TerminalSessionBackup> = {
        terminal: { coinsOfInterest: [] } as NonNullable<TerminalSessionBackup>['terminal'],
        presentation: {} as NonNullable<TerminalSessionBackup>['presentation'],
      };
      const saveTerminalSession = jest.fn().mockResolvedValue(undefined);
      const onCommitted = jest.fn();
      const clearSessionPreservingHistory = jest.fn();

      await persistFreshStartCheckpoint({
        epoch,
        getCurrentEpoch: () => epoch,
        loadState: () =>
          ({
            phase: 'terminal',
            terminal: terminalBackup.terminal,
            presentation: terminalBackup.presentation,
          }) as ReturnType<Parameters<typeof persistFreshStartCheckpoint>[0]['loadState']>,
        replaceSession: async () => {
          epoch += 1;
        },
        saveTerminalSession,
        clearSessionPreservingHistory,
        checkpoint,
        onCommitted,
      });

      expect(onCommitted).toHaveBeenCalled();
      expect(saveTerminalSession).toHaveBeenCalled();
      expect(clearSessionPreservingHistory).not.toHaveBeenCalled();
    });

    it('leaves persist committed when terminal restore fails after Cancel raced the write', async () => {
      let epoch = 7;
      const onCommitted = jest.fn();
      await expect(
        persistFreshStartCheckpoint({
          epoch,
          getCurrentEpoch: () => epoch,
          loadState: () =>
            ({
              phase: 'terminal',
              terminal: { coinsOfInterest: [] },
              presentation: {},
            }) as ReturnType<Parameters<typeof persistFreshStartCheckpoint>[0]['loadState']>,
          replaceSession: async () => {
            epoch += 1;
          },
          saveTerminalSession: async () => {
            throw new Error('restore failed');
          },
          clearSessionPreservingHistory: jest.fn(),
          checkpoint,
          onCommitted,
        }),
      ).rejects.toThrow(/restore failed/);
      expect(onCommitted).toHaveBeenCalled();
      expect(startFailureDisposition(true)).toBe('cancel-attempt');
    });
  });
});
