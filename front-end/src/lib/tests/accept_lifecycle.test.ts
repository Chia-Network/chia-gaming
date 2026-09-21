import {
  ACCEPT_SETUP_CANCEL_CHANNEL_STATES,
  captureFreshStart,
  channelSetupCoverCopy,
  shouldCompleteAcceptTransition,
  shouldSynthesizeSetupPending,
  startFailureDisposition,
  type FreshStartCheckpoint,
} from '../session/acceptLifecycle';
import type { SessionModel } from '../session/types';
import type { ChannelStatus } from '../../types/ChiaGaming';
import { storageRepository } from '../session/storageRepository';
import { baseSave } from './session_save_envelope.fixtures';
import './save.harness';

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
  describe('channelSetupCoverCopy', () => {
    it('replaces setup progress with the failure advisory after channel expiry', () => {
      expect(
        channelSetupCoverCopy(false, {
          state: 'Failed',
          advisory: 'channel coin not confirmed in time',
        }),
      ).toBe('channel coin not confirmed in time');
    });

    it('uses explicit fallback copy when a setup failure has no advisory', () => {
      expect(channelSetupCoverCopy(false, { state: 'Failed', advisory: null })).toBe(
        'Channel setup failed.',
      );
    });

    it('keeps setup progress while the channel remains pre-active', () => {
      expect(channelSetupCoverCopy(false, { state: 'TransactionPending', advisory: null })).toBe(
        'Setting up channel…',
      );
    });
  });

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

  describe('captureFreshStart', () => {
    const checkpoint: FreshStartCheckpoint = {
      walletProviderScope: { provider: 'simulator', identity: 'accept-lifecycle' },
      pairing: {
        token: 't1',
        peerId: 'peer',
        gameSessionId: '50'.repeat(16),
        iStarted: true,
        myContribution: '10',
        theirContribution: '10',
        perGameAmount: '1',
      },
      transport: {
        messageNumber: 1n,
        remoteNumber: 0n,
        unackedMessages: [],
        disposition: 'active',
        terminalHandoff: null,
      },
    };

    it('skips the write when the start epoch already advanced', async () => {
      const before = structuredClone(storageRepository.loadState());
      await captureFreshStart({
        epoch: 1,
        getCurrentEpoch: () => 2,
        checkpoint,
        onCommitted: jest.fn(),
      });
      expect(storageRepository.loadState()).toEqual(before);
    });

    it('captures one complete pre-handshake root and marks it committed', async () => {
      const onCommitted = jest.fn();
      await captureFreshStart({
        epoch: 3,
        getCurrentEpoch: () => 3,
        checkpoint,
        onCommitted,
      });
      expect(storageRepository.loadState().session).toMatchObject({
        phase: 'pre-handshake',
        pairing: checkpoint.pairing,
        transport: checkpoint.transport,
      });
      expect(onCommitted).toHaveBeenCalled();
    });

    it('restores the prior terminal phase when Cancel races the write', async () => {
      let epoch = 5;
      const terminal = baseSave({
        channelStatus: { state: 'ResolvedClean' },
        coinsOfInterest: [],
        terminalIStarted: true,
      });
      await storageRepository.checkpointApplicationState(terminal);
      const onCommitted = jest.fn();
      onCommitted.mockImplementation(() => {
        epoch += 1;
      });
      await captureFreshStart({
        epoch,
        getCurrentEpoch: () => epoch,
        checkpoint,
        onCommitted,
      });

      expect(onCommitted).toHaveBeenCalled();
      expect(storageRepository.loadState().session).toEqual(terminal.session);
    });
  });
});
