import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const mockJoinHub = jest.fn();
const mockSetAlias = jest.fn();
let mockSavedAlias: string | null = null;

jest.mock('../../../../hub/hub-frontend/src/useHubSocket', () => ({
  useHubSocket: () => ({
    players: [],
    hubUpdateReceived: false,
    pendingChallenge: null,
    challengeSent: false,
    isConnected: true,
    isReconnecting: false,
    initialConnectionFailed: false,
    reconnectBlocked: false,
    savedAlias: mockSavedAlias,
    aliasLoaded: true,
    joinHub: mockJoinHub,
    setAlias: mockSetAlias,
    sendChallenge: jest.fn(),
    acceptChallenge: jest.fn(),
    declineChallenge: jest.fn(),
    cancelChallenge: jest.fn(),
    setHubAlias: jest.fn(),
    publicId: null,
  }),
}));

import HubScreen from '../../../../hub/hub-frontend/src/hub';

describe('hub automatic join', () => {
  it('does not auto-join again when a manually entered alias is saved', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'https://hub.example' } },
    });
    mockSavedAlias = null;
    mockJoinHub.mockClear();
    mockSetAlias.mockClear();

    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(React.createElement(HubScreen, { sessionId: 'ab'.repeat(16) }));
    });

    const input = renderer!.root.findByProps({ placeholder: 'Your name' });
    act(() => {
      input.props.onChange({ target: { value: 'Alice' } });
    });
    act(() => {
      input.props.onKeyDown({ key: 'Enter' });
    });

    expect(mockSetAlias).toHaveBeenCalledWith('Alice');
    expect(mockJoinHub).toHaveBeenCalledTimes(1);
    expect(mockJoinHub).toHaveBeenCalledWith('Alice');

    mockSavedAlias = 'Alice';
    act(() => {
      renderer!.update(React.createElement(HubScreen, { sessionId: 'ab'.repeat(16) }));
    });
    expect(mockJoinHub).toHaveBeenCalledTimes(1);
  });
});
