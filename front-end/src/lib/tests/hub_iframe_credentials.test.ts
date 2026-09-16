import { webcrypto } from 'node:crypto';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  hubSessionFromParentMessage,
  parentOriginsFromPayload,
} from '../../../../hub/hub-frontend/src/iframeAuth';
import { HubIframe } from '../../components/HubIframe';
import { installHubIframeAuthentication } from '../../services/hubIframeAuthentication';
import { canonicalHubOrigin, deriveHubSessionId } from '../../services/hubSessionCredential';

type MessageHandler = (event: MessageEvent) => void;

function childAuthMessage(
  source: unknown,
  sessionId: unknown,
  origin = 'https://player.example',
): MessageEvent {
  return {
    source,
    origin,
    data: { type: 'hub-auth', sessionId },
  } as unknown as MessageEvent;
}

function parentAuthMessage(source: unknown, origin: string, data: unknown): MessageEvent {
  return { source, origin, data } as unknown as MessageEvent;
}

function createParentHarness() {
  const loadHandlers = new Set<() => void>();
  const messageHandlers = new Set<MessageHandler>();
  const posts: Array<{ destination: unknown; message: unknown; targetOrigin: string }> = [];
  const frameWindow = {
    postMessage(message: unknown, targetOrigin: string) {
      posts.push({ destination: frameWindow, message, targetOrigin });
    },
  };
  const otherWindow = {
    postMessage(message: unknown, targetOrigin: string) {
      posts.push({ destination: otherWindow, message, targetOrigin });
    },
  };
  const iframe = {
    contentWindow: frameWindow,
    addEventListener(_type: 'load', listener: () => void) {
      loadHandlers.add(listener);
    },
    removeEventListener(_type: 'load', listener: () => void) {
      loadHandlers.delete(listener);
    },
  };
  const messageTarget = {
    addEventListener(_type: 'message', listener: MessageHandler) {
      messageHandlers.add(listener);
    },
    removeEventListener(_type: 'message', listener: MessageHandler) {
      messageHandlers.delete(listener);
    },
  };

  return {
    iframe,
    messageTarget,
    frameWindow,
    otherWindow,
    posts,
    dispatchMessage: (event: MessageEvent) => messageHandlers.forEach((handler) => handler(event)),
    dispatchLoad: () => loadHandlers.forEach((handler) => handler()),
    listenerCounts: () => ({ load: loadHandlers.size, message: messageHandlers.size }),
  };
}

afterEach(() => {
  jest.useRealTimers();
});

describe('hub iframe credentials', () => {
  it('accepts a canonical session only from the embedding parent', () => {
    const parent = {} as Window;
    const sessionId = 'ab'.repeat(16);
    const allowedOrigins = new Set(['https://player.example']);

    expect(
      hubSessionFromParentMessage(childAuthMessage(parent, sessionId), parent, allowedOrigins),
    ).toBe(sessionId);
    expect(
      hubSessionFromParentMessage(childAuthMessage({}, sessionId), parent, allowedOrigins),
    ).toBeNull();
    expect(
      hubSessionFromParentMessage(
        childAuthMessage(parent, sessionId, 'https://attacker.example'),
        parent,
        allowedOrigins,
      ),
    ).toBeNull();
    expect(
      hubSessionFromParentMessage(
        childAuthMessage(parent, 'not-a-session'),
        parent,
        allowedOrigins,
      ),
    ).toBeNull();
  });

  it('accepts only a nonempty parent-origin policy list', () => {
    expect(parentOriginsFromPayload({ origins: ['chiagaming://app'] })).toEqual(
      new Set(['chiagaming://app']),
    );
    expect(parentOriginsFromPayload({ origins: [] })).toBeNull();
    expect(parentOriginsFromPayload({ origins: [7] })).toBeNull();
    expect(parentOriginsFromPayload(null)).toBeNull();
  });

  it('renders the iframe without credentials or referrer leakage', () => {
    const sessionId = 'ab'.repeat(16);
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(React.createElement(HubIframe, { iframeUrl: 'https://hub.example/' }));
    });
    const iframe = renderer!.root.findByType('iframe');

    expect(iframe.props.src).toBe('https://hub.example/');
    expect(iframe.props.referrerPolicy).toBe('no-referrer');
    expect(JSON.stringify(iframe.props)).not.toContain(sessionId);
  });

  it('waits for the iframe load before sending credentials to its canonical origin', () => {
    const harness = createParentHarness();
    installHubIframeAuthentication({
      iframe: harness.iframe,
      iframeUrl: 'https://HUB.example:443/path?ignored=1',
      sessionId: 'ab'.repeat(16),
      messageTarget: harness.messageTarget,
    });

    expect(harness.posts).toEqual([]);
    harness.dispatchLoad();
    expect(harness.posts).toEqual([
      {
        destination: harness.frameWindow,
        message: { type: 'hub-auth', sessionId: 'ab'.repeat(16) },
        targetOrigin: 'https://hub.example',
      },
    ]);
  });

  it('responds only to well-formed requests from the iframe at the canonical origin', () => {
    jest.useFakeTimers();
    const harness = createParentHarness();
    installHubIframeAuthentication({
      iframe: harness.iframe,
      iframeUrl: 'https://hub.example/hub',
      sessionId: 'cd'.repeat(16),
      messageTarget: harness.messageTarget,
    });

    const validRequest = { type: 'hub-auth-request' };
    harness.dispatchMessage(
      parentAuthMessage(harness.frameWindow, 'https://hub.example', validRequest),
    );
    expect(harness.posts).toEqual([
      {
        destination: harness.frameWindow,
        message: { type: 'hub-auth', sessionId: 'cd'.repeat(16) },
        targetOrigin: 'https://hub.example',
      },
    ]);

    const rejected = [
      parentAuthMessage(harness.otherWindow, 'https://hub.example', validRequest),
      parentAuthMessage(harness.frameWindow, 'https://other.example', validRequest),
      parentAuthMessage(harness.frameWindow, 'https://hub.example', null),
      parentAuthMessage(harness.frameWindow, 'https://hub.example', 'hub-auth-request'),
      parentAuthMessage(harness.frameWindow, 'https://hub.example', {}),
      parentAuthMessage(harness.frameWindow, 'https://hub.example', { type: 'hub-auth' }),
    ];
    rejected.forEach(harness.dispatchMessage);
    expect(harness.posts).toHaveLength(1);
  });

  it('removes listeners during cleanup', () => {
    const harness = createParentHarness();
    const cleanup = installHubIframeAuthentication({
      iframe: harness.iframe,
      iframeUrl: 'https://hub.example/',
      sessionId: 'ef'.repeat(16),
      messageTarget: harness.messageTarget,
    });

    expect(harness.listenerCounts()).toEqual({ load: 1, message: 1 });
    cleanup();
    expect(harness.listenerCounts()).toEqual({ load: 0, message: 0 });

    harness.dispatchLoad();
    harness.dispatchMessage(
      parentAuthMessage(harness.frameWindow, 'https://hub.example', {
        type: 'hub-auth-request',
      }),
    );
    expect(harness.posts).toEqual([]);
  });

  it('derives distinct bearer credentials for canonical hub origins', async () => {
    const master = '01'.repeat(16);
    const subtle = webcrypto.subtle as unknown as SubtleCrypto;

    const hubA = await deriveHubSessionId(master, 'https://hub.example/path?ignored=1', subtle);
    const canonicalHubA = await deriveHubSessionId(master, 'https://hub.example:443/', subtle);
    const hubB = await deriveHubSessionId(master, 'https://other.example/', subtle);

    expect(canonicalHubOrigin('https://HUB.example:443/path')).toBe('https://hub.example');
    expect(hubA).toBe(canonicalHubA);
    expect(hubA).toMatch(/^[0-9a-f]{32}$/);
    expect(hubA).not.toBe(hubB);
    await expect(deriveHubSessionId(hubA, 'https://other.example/', subtle)).resolves.not.toBe(
      hubB,
    );
  });
});
