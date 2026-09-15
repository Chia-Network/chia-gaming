import fs from 'node:fs';
import path from 'node:path';
import { hubSessionFromParentMessage } from '../../../../hub/hub-frontend/src/iframeAuth';

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
});
