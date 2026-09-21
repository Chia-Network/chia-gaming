import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useSessionRejection } from '../../hooks/useSessionRejection';
import type { HubConnection } from '../../services/HubConnection';
import { PeerSession } from '../../services/PeerSession';
import { storageRepository } from '../session/storageRepository';
import type { DurableRejectionTransport } from '../session/saveEnvelope';

function mockHub(): HubConnection & { sendToPeer: jest.Mock } {
  return {
    sendToPeer: jest.fn(() => true),
  } as unknown as HubConnection & { sendToPeer: jest.Mock };
}

describe('useSessionRejection authority owner', () => {
  let renderer: ReactTestRenderer | undefined;
  let primary: PeerSession | null;
  let api: ReturnType<typeof useSessionRejection>;

  function Harness() {
    api = useSessionRejection({
      getPrimaryPeer: () => primary,
      getDurableSession: () => null,
      releasePrimaryPeer: (peer) => {
        if (primary === peer) primary = null;
      },
    });
    return null;
  }

  afterEach(() => {
    act(() => renderer?.unmount());
    jest.restoreAllMocks();
  });

  it('restores and replays a durable outbound rejection at boot', async () => {
    const hub = mockHub();
    const tombstone: DurableRejectionTransport = {
      kind: 'outbound-reject',
      peerId: 'peer-1',
      sessionId: '00'.repeat(16),
      createdAt: 1,
      messageNumber: 2n,
      remoteNumber: 1n,
      unackedMessages: [{ msgno: 1n, msg: new Uint8Array([0x64, 0x65]) }],
    };
    act(() => {
      renderer = create(createElement(Harness));
    });
    await act(async () => {
      await api.restore(hub, [tombstone]);
    });

    expect(hub.sendToPeer).toHaveBeenCalledTimes(1);
    expect((hub.sendToPeer.mock.calls[0][1] as Uint8Array)[0]).toBe(0x01);
  });

  it('releases primary authority before persistence and launches once after handoff', async () => {
    const hub = mockHub();
    primary = new PeerSession('peer-1', '11'.repeat(16), hub);
    primary.reliableState.remoteNumber = 1n;
    const saved = storageRepository.loadState();
    jest.spyOn(storageRepository, 'loadState').mockReturnValue(saved);
    let finishWrite!: () => void;
    jest
      .spyOn(storageRepository, 'prepareApplicationStateCapture')
      .mockImplementation((transform) => ({
        state: transform(storageRepository.loadState()),
        write: () =>
          new Promise<void>((resolve) => {
            finishWrite = resolve;
          }),
      }));

    act(() => {
      renderer = create(createElement(Harness));
    });
    let rejection!: Promise<void>;
    act(() => {
      rejection = api.sendSessionReject('peer-1');
    });

    expect(primary).toBeNull();
    expect(hub.sendToPeer).not.toHaveBeenCalled();
    finishWrite();
    await act(async () => {
      await rejection;
    });
    expect(hub.sendToPeer).toHaveBeenCalledTimes(1);
  });
});
