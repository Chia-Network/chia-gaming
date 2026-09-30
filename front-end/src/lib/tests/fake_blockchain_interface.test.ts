import {
  FakeBlockchainInterface,
  SimulatorTransportError,
} from '../../hooks/FakeBlockchainInterface';
import type { WalletOfferOperation, WalletOfferRequest } from '../../types/ChiaGaming';

const operation: WalletOfferOperation = {
  owner: {
    installationPlayerId: 'player',
    peerSessionId: 'session',
    providerScope: { provider: 'simulator', identity: 'player' },
  },
  purpose: { kind: 'funding', operationId: 'funding' },
};

const request: WalletOfferRequest = {
  kind: 'funding',
  uniqueId: 'player',
  offer: { '1': -100_000_100n },
};

function rejectNextRequest(iface: FakeBlockchainInterface, error: Error): void {
  (
    iface as unknown as {
      sendRequest(method: string, params?: unknown): Promise<unknown>;
    }
  ).sendRequest = jest.fn().mockRejectedValue(error);
}

describe('FakeBlockchainInterface funding offers', () => {
  it('defaults simulator wallets above the minimum opening fee', async () => {
    const setup = await new FakeBlockchainInterface('ws://simulator').beginConnect('player');

    expect(setup.fields?.balance.default).toBe(1_000_000_000n);
  });

  it('returns simulator offer rejections as wallet failures', async () => {
    const iface = new FakeBlockchainInterface('ws://simulator');
    rejectNextRequest(iface, new Error('no spendable coin for requested amount'));

    await expect(iface.beginWalletOffer(operation, request)).resolves.toEqual({
      kind: 'failure',
      reason: 'no spendable coin for requested amount',
    });
  });

  it('returns simulator transport failures as unavailable', async () => {
    const iface = new FakeBlockchainInterface('ws://simulator');
    rejectNextRequest(iface, new SimulatorTransportError('WebSocket closed'));

    await expect(iface.beginWalletOffer(operation, request)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'WebSocket closed',
    });
  });
});
