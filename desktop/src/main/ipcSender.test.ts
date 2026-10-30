import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isPlayerDocumentSender } from './ipcSender.ts';

describe('IPC sender check', () => {
  const mainFrame = { url: 'chiagaming://app/index.html' };

  it('accepts only the player document top frame', () => {
    assert.ok(isPlayerDocumentSender({ senderFrame: mainFrame, sender: { mainFrame } }));
    assert.ok(
      !isPlayerDocumentSender({
        senderFrame: { url: 'https://hub.example/lobby' },
        sender: { mainFrame },
      }),
    );
    const remote = { url: 'https://wallet.example/' };
    assert.ok(!isPlayerDocumentSender({ senderFrame: remote, sender: { mainFrame: remote } }));
    assert.ok(!isPlayerDocumentSender({ senderFrame: null, sender: { mainFrame } }));
  });
});
