import { webcrypto } from 'node:crypto';
import { hubSessionFromParentMessage } from '../../../../hub/hub-frontend/src/iframeAuth';
import { installHubIframeAuthentication } from '../../services/hubIframeAuthentication';
import { canonicalHubOrigin, deriveHubSessionId } from '../../services/hubSessionCredential';

type MessageHandler = (event: MessageEvent) => void;

function childAuthMessage(source: unknown, sessionId: unknown): MessageEvent {
  return {
    source,
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

    expect(hubSessionFromParentMessage(childAuthMessage(parent, sessionId), parent)).toBe(
      sessionId,
    );
    expect(hubSessionFromParentMessage(childAuthMessage({}, sessionId), parent)).toBeNull();
    expect(
      hubSessionFromParentMessage(childAuthMessage(parent, 'not-a-session'), parent),
    ).toBeNull();
  });

  it('sends credentials to the iframe at its canonical origin on load and initial retry', () => {
    jest.useFakeTimers();
    const harness = createParentHarness();
    installHubIframeAuthentication({
      iframe: harness.iframe,
      iframeUrl: 'https://HUB.example:443/path?ignored=1',
      sessionId: 'ab'.repeat(16),
      messageTarget: harness.messageTarget,
    });

    harness.dispatchLoad();
    expect(harness.posts).toEqual([
      {
        destination: harness.frameWindow,
        message: { type: 'hub-auth', sessionId: 'ab'.repeat(16) },
        targetOrigin: 'https://hub.example',
      },
    ]);

    jest.advanceTimersByTime(150);
    expect(harness.posts).toHaveLength(2);
    expect(harness.posts[1]).toEqual(harness.posts[0]);
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

  it('removes listeners and cancels the initial retry during cleanup', () => {
    jest.useFakeTimers();
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
    jest.advanceTimersByTime(150);
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
