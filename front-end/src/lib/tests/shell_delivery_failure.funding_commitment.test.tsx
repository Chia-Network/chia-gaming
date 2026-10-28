import 'fake-indexeddb/auto';

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import Shell from '../../components/Shell';
import { realBlockchainInfo } from '../../hooks/RealBlockchainInterface';
import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { deactivate } from '../../hooks/activeBlockchain';
import { storageRepository } from '../session/storageRepository';
import { markSavedSession, releaseLeaseIfOwner } from '../../hooks/saveCoordination';
import { _resetPendingWalletConnectWipeForTests } from '../../hooks/saveHardReset';
import { SESSION_DB_NAME } from '../session/indexedDb';
import { liveSave } from './session_save_envelope.fixtures';
import { createSessionModel, INITIAL_CHANNEL_STATUS_MODEL } from '../session/model';
import type { ComponentProps } from 'react';
import type GameSession from '../../components/GameSession';
import { SessionMachineRuntime } from '../session/sessionMachineRuntime';
import { createSessionMachineState } from '../session/sessionMachine';
import { ReliablePeerTransport } from '../../services/PeerSession';
import { sessionReceivePolicy } from '../session/receivePolicy';
import type { SessionController } from '../../hooks/SessionController';
import type { HubConnection } from '../../services/HubConnection';

let mockGameProps: ComponentProps<typeof GameSession> | null = null;
let mockProjectFundingOffer: (() => void) | null = null;
let mockHubCallbacks: ConstructorParameters<typeof HubConnection>[2] | null = null;
const mockSendToPeer = jest.fn((_peerId: string, _payload: Uint8Array) => true);

jest.mock('../../components/GameSession', () => ({
  __esModule: true,
  default: function MockGameSession(props: ComponentProps<typeof GameSession>) {
    const React = jest.requireActual<typeof import('react')>('react');
    const [state, setState] = React.useState<'OurWalletMakingOfferAcceptance' | 'OfferSent'>(
      'OurWalletMakingOfferAcceptance',
    );
    mockGameProps = props;
    mockProjectFundingOffer = () => setState('OfferSent');
    React.useEffect(() => {
      props.onSessionModelChange!(channelModel(state));
    }, [state, props.onSessionModelChange]);
    return null;
  },
  GameSessionErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
  UncaughtClientErrorReporter: () => null,
}));

jest.mock('../../services/HubConnection', () => {
  const actual = jest.requireActual('../../services/HubConnection');
  return {
    ...actual,
    HubConnection: jest.fn((_origin, _sessionId, callbacks) => {
      mockHubCallbacks = callbacks;
      return {
        disconnect: jest.fn(),
        setBusy: jest.fn(),
        getPlayerId: () => '11'.repeat(32),
        sendToPeer: mockSendToPeer,
      };
    }),
  };
});

function channelModel(state: 'OurWalletMakingOfferAcceptance' | 'OfferSent') {
  return createSessionModel({
    channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state } },
  });
}

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

function classList() {
  const values = new Set<string>();
  return {
    add: (value: string) => values.add(value),
    contains: (value: string) => values.has(value),
    remove: (value: string) => values.delete(value),
  };
}

async function deleteSessionDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(SESSION_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForText(renderer: ReactTestRenderer, text: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const rendered = renderer.root
      .findAll((node) => typeof node.type === 'string')
      .flatMap((node) => node.children)
      .filter((child): child is string => typeof child === 'string')
      .join('\n');
    if (rendered.includes(text)) return;
    await flushEffects();
  }
  throw new Error(`Timed out waiting for Shell text: ${text}`);
}

describe('Shell delivery failure at the funding commitment boundary', () => {
  let renderer: ReactTestRenderer | null = null;
  let requestTrust: jest.Mock;
  let unhandledRejections: unknown[];
  let onUnhandledRejection: (reason: unknown) => void;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

  beforeEach(async () => {
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage(),
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: storage(),
    });
    requestTrust = jest.fn(async () => 'trusted');
    mockGameProps = null;
    mockProjectFundingOffer = null;
    mockHubCallbacks = null;
    mockSendToPeer.mockClear();
    unhandledRejections = [];
    onUnhandledRejection = (reason) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __chiaHub: { requestTrust },
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        location: { reload: jest.fn() },
      },
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        body: { style: { cursor: '', userSelect: '' } },
        documentElement: { classList: classList() },
        getElementById: jest.fn(() => null),
      },
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText: jest.fn() } },
    });
    storageRepository._resetForTests();
    _resetPendingWalletConnectWipeForTests();
    await deleteSessionDatabase();

    jest
      .spyOn(realBlockchainInfo, 'beginConnect')
      .mockImplementation(() => new Promise<never>(() => {}));
    jest.spyOn(realBlockchainInfo, 'isConnected').mockReturnValue(false);
    jest.spyOn(realBlockchainInfo, 'isReadyForPlay').mockReturnValue(false);
    jest.spyOn(realBlockchainInfo, 'onConnectionChange').mockReturnValue(() => {});
  });

  afterEach(async () => {
    await act(async () => {
      await storageRepository.inspect();
      renderer?.unmount();
    });
    renderer = null;
    await storageRepository.inspect();
    jest.restoreAllMocks();
    process.off('unhandledRejection', onUnhandledRejection);
    storageRepository._resetForTests();
    _resetPendingWalletConnectWipeForTests();
    await deleteSessionDatabase();
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'navigator');
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  async function mountHandshake(): Promise<void> {
    await storageRepository.claimApplicationState();
    const save = liveSave({
      blockchainType: 'walletconnect',
      hubUrl: 'https://hub.example.test',
      activeTab: 'game',
      sessionPeerId: '22'.repeat(32),
      myHubPlayerId: '11'.repeat(32),
      channelStatus: { state: 'OurWalletMakingOfferAcceptance' },
    });
    await storageRepository.write(storageRepository.patchApplicationState(() => save));
    markSavedSession();
    releaseLeaseIfOwner();
    storageRepository._resetForTests();
    act(() => {
      renderer = create(React.createElement(Shell));
    });
    await waitForText(renderer!, 'You have previously saved state.');
    await act(async () => {
      await renderer!.root.findByProps({ children: 'Resume Session' }).props.onClick();
    });
    for (let attempt = 0; attempt < 30 && (!mockHubCallbacks || !mockGameProps); attempt++) {
      await flushEffects();
    }
    expect(mockHubCallbacks).not.toBeNull();
    expect(mockGameProps).not.toBeNull();
    act(() => {
      mockHubCallbacks!.onRegistered('11'.repeat(32));
      mockGameProps!.onRestoreStatusChange!('restored', null);
      mockGameProps!.onSessionPhaseChange!('off-chain', false);
      mockGameProps!.onSessionModelChange!(channelModel('OurWalletMakingOfferAcceptance'));
    });
    await act(async () => {
      await storageRepository.inspect();
    });
    mockSendToPeer.mockClear();
  }

  // WASM/funding is stubbed at the completed-offer boundary. Shell, PeerSession,
  // the delivery-failure handler, and saved-session teardown are production code.
  async function sendFundingOffer(): Promise<void> {
    const connection = mockGameProps!.peerConn;
    const transport = new ReliablePeerTransport(
      connection.reliableState!,
      sessionReceivePolicy(),
      (msgno, body) => connection.sendMessage(Number(msgno), body),
      (msgno) => connection.sendAck(Number(msgno)),
    );
    const order: string[] = [];
    const controller = {
      commitSessionRuntime: jest.fn(),
      flushDeferredWork: jest.fn(),
      prepareReliableCommit: () => transport.prepareCommit(),
      completeReliableCommit: (commit, success) => {
        order.push('release');
        transport.completeCommit(commit, success);
      },
    } as unknown as SessionController;
    const runtime = new SessionMachineRuntime(
      createSessionMachineState(channelModel('OurWalletMakingOfferAcceptance')),
      {
        controller,
        iStarted: false,
        restoring: false,
        getRestoreStatus: () => 'restored',
        getRestoreError: () => null,
        onError: (error) => {
          throw error;
        },
        persist: async (state) => {
          const snapshot = storageRepository.patchApplicationState((saved) => {
            if (saved.session?.phase !== 'live') throw new Error('expected live session');
            return {
              ...saved,
              session: {
                ...saved.session,
                live: {
                  ...saved.session.live,
                  messageNumber: transport.state.messageNumber,
                  unackedMessages: structuredClone(transport.state.unackedMessages),
                },
                presentation: {
                  ...saved.session.presentation,
                  channelStatus: {
                    ...saved.session.presentation.channelStatus!,
                    state: state.model.channel.status.state,
                  },
                },
              },
            };
          });
          await storageRepository.write(snapshot);
          order.push('saved');
        },
      },
    );
    runtime.setRender(() => {
      order.push('projection');
      mockProjectFundingOffer!();
    });
    runtime.activate();
    runtime.activatePersistence();
    transport.attachCommitCoordinator(runtime);
    try {
      // A projected funding event and a real Rust proposal share this checkpoint.
      // Persistence, React projection scheduling, and queued release are real.
      runtime.dispatch({
        type: 'wasm-notification',
        iStarted: false,
        notification: {
          ChannelStatus: {
            state: 'OfferSent',
            advisory: null,
            coin: null,
            our_balance: null,
            their_balance: null,
            game_allocated: null,
          },
        },
      });
      transport.acceptSession({ proposer_amount: '100', responder_amount: '100' }, true);
      expect(mockSendToPeer).not.toHaveBeenCalled();
      await runtime.persist();
      expect(order.slice(0, 3)).toEqual(['saved', 'projection', 'release']);
      expect(mockSendToPeer).toHaveBeenCalledTimes(1);
      expect(mockSendToPeer.mock.calls[0][0]).toBe('22'.repeat(32));
    } finally {
      transport.detachCommitCoordinator(runtime);
      runtime.retire();
    }
  }

  it('cancels an unreachable peer before any funding offer is sent', async () => {
    await mountHandshake();
    act(() => mockHubCallbacks!.onDeliveryFailure('22'.repeat(32)));
    await act(async () => {
      await storageRepository.inspect();
    });
    expect(mockSendToPeer).not.toHaveBeenCalled();
    expect(storageRepository.loadState().session).toMatchObject({
      phase: 'pre-handshake',
      pairing: { peerId: undefined },
    });
  });

  it('preserves a sent offer when the UI has projected OfferSent', async () => {
    await mountHandshake();
    await act(async () => {
      await sendFundingOffer();
    });
    act(() => mockHubCallbacks!.onDeliveryFailure('22'.repeat(32)));
    await act(async () => {
      await storageRepository.inspect();
    });
    const persisted = (await storageRepository.inspect()).applicationState;
    expect(persisted?.session).toMatchObject({
      phase: 'live',
      presentation: { channelStatus: { state: 'OfferSent' } },
    });
  });

  it('preserves the accepted handshake and peer when the wallet disconnects and reconnects', async () => {
    let connectionChange: ((connected: boolean) => void) | undefined;
    jest.spyOn(realBlockchainInfo, 'onConnectionChange').mockImplementation((callback) => {
      connectionChange = callback;
      return () => {};
    });
    const disconnect = jest.spyOn(realBlockchainInfo, 'disconnect').mockResolvedValue();
    jest.spyOn(BlockchainPoller.prototype, 'start').mockImplementation(() => {});
    jest.spyOn(realBlockchainInfo, 'getBalance').mockResolvedValue(0n);
    jest
      .spyOn(realBlockchainInfo, 'beginConnect')
      .mockResolvedValue({ skipQr: true, finalize: async () => {} });
    jest.spyOn(realBlockchainInfo, 'isReadyForPlay').mockReturnValue(true);
    await mountHandshake();
    const peer = mockGameProps!.peerConn;
    const params = mockGameProps!.params;
    act(() => connectionChange!(true));
    act(() => renderer!.root.findByProps({ 'aria-label': 'Wallet, connected' }).props.onClick());
    act(() =>
      renderer!.root
        .findAll(
          (node) => node.props.variant === 'solid' && node.props.children === 'Disconnect',
        )[0]
        .props.onClick(),
    );
    await act(async () => {
      await renderer!.root
        .findAll((node) => node.type === 'button' && node.props.children === 'Proceed')[0]
        .props.onClick();
    });
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(mockGameProps!.peerConn).toBe(peer);
    expect(mockGameProps!.params).toEqual(params);
    expect(storageRepository.loadState().session).toMatchObject({
      phase: 'live',
      pairing: { peerId: '22'.repeat(32) },
    });
    expect(mockSendToPeer).not.toHaveBeenCalled();
    jest
      .spyOn(realBlockchainInfo, 'beginConnect')
      .mockResolvedValue({ skipQr: true, finalize: async () => {} });
    jest.spyOn(realBlockchainInfo, 'isReadyForPlay').mockReturnValue(true);
    await act(async () => {
      await renderer!.root
        .findAll(
          (node) => node.props.variant === 'solid' && node.props.children === 'Link Wallet',
        )[0]
        .props.onClick();
    });
    await waitForText(renderer!, 'Connected');
    expect(mockGameProps!.peerConn).toBe(peer);
    expect(mockGameProps!.params).toEqual(params);
    deactivate();
  });

  it('updates pending consent when only wallet readiness changes', async () => {
    let readinessChange: ((ready: boolean) => void) | undefined;
    jest.spyOn(realBlockchainInfo, 'onPlayReadinessChange').mockImplementation((callback) => {
      readinessChange = callback;
      return () => {};
    });
    jest.spyOn(realBlockchainInfo, 'beginConnect').mockResolvedValue({
      skipQr: true,
      finalize: async () => {},
    });
    jest.spyOn(BlockchainPoller.prototype, 'start').mockImplementation(() => {});
    jest.spyOn(realBlockchainInfo, 'getBalance').mockResolvedValue(0n);
    await storageRepository.claimApplicationState();
    const save = liveSave({
      blockchainType: 'walletconnect',
      hubUrl: 'https://hub.example.test',
      activeTab: 'game',
      sessionPeerId: '22'.repeat(32),
      myHubPlayerId: '11'.repeat(32),
      iStarted: false,
    });
    if (save.session?.phase !== 'live') throw new Error('expected live fixture');
    save.session = {
      phase: 'pre-handshake',
      pairing: save.session.pairing,
      transport: {
        messageNumber: 1n,
        remoteNumber: 1n,
        unackedMessages: [],
        disposition: 'proposal-received',
        terminalHandoff: null,
      },
    };
    await storageRepository.write(storageRepository.patchApplicationState(() => save));
    markSavedSession();
    releaseLeaseIfOwner();
    storageRepository._resetForTests();
    act(() => {
      renderer = create(<Shell />);
    });
    await waitForText(renderer!, 'You have previously saved state.');
    await act(async () =>
      renderer!.root.findByProps({ children: 'Resume Session' }).props.onClick(),
    );
    await waitForText(renderer!, 'Connected');
    await waitForText(renderer!, 'Accept');
    for (let attempt = 0; attempt < 30 && !readinessChange; attempt++) {
      await flushEffects();
    }
    expect(readinessChange).toBeDefined();
    const accept = () => renderer!.root.findByProps({ children: 'Accept' });
    expect(accept().props.disabled).toBe(true);
    act(() => readinessChange!(true));
    expect(accept().props.disabled).toBe(false);
    act(() => readinessChange!(false));
    expect(accept().props.disabled).toBe(true);
    deactivate();
  });

  it('preserves a sent offer when delivery fails before the UI projects OfferSent', async () => {
    await mountHandshake();
    await act(async () => {
      await sendFundingOffer();
      // Deliver failure before the queued React projection/effect can run.
      mockHubCallbacks!.onDeliveryFailure('22'.repeat(32));
    });
    await act(async () => {
      await storageRepository.inspect();
    });
    const persisted = (await storageRepository.inspect()).applicationState;
    expect(persisted?.session).toMatchObject({
      phase: 'live',
      presentation: { channelStatus: { state: 'OfferSent' } },
    });
  });
});
