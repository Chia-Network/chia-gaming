import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { hubSessionFromParentMessage } from '../../../../hub/hub-frontend/src/iframeAuth';
import { canonicalHubOrigin, deriveHubSessionId } from '../../services/hubSessionCredential';

function authMessage(source: unknown, sessionId: unknown): MessageEvent {
  return {
    source,
    data: { type: 'hub-auth', sessionId },
  } as unknown as MessageEvent;
}

describe('hub iframe credentials', () => {
  it('accepts a canonical session only from the embedding parent', () => {
    const parent = {} as Window;
    const sessionId = 'ab'.repeat(16);

    expect(hubSessionFromParentMessage(authMessage(parent, sessionId), parent)).toBe(sessionId);
    expect(hubSessionFromParentMessage(authMessage({}, sessionId), parent)).toBeNull();
    expect(hubSessionFromParentMessage(authMessage(parent, 'not-a-session'), parent)).toBeNull();
  });

  it('keeps the bearer credential out of the iframe URL', () => {
    const shell = fs.readFileSync(path.resolve(__dirname, '../../components/Shell.tsx'), 'utf8');

    expect(shell).not.toContain('?session=');
    expect(shell).toContain("postMessage({ type: 'hub-auth', sessionId }, targetOrigin)");
    expect(shell).toContain('referrerPolicy="no-referrer"');
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
