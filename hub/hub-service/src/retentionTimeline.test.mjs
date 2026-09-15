import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deadlineReached, RetentionTimeline } from '../dist/retentionTimeline.js';

test('retention expiry uses the injected clock from the inactive boundary', () => {
  let now = 1_000;
  const timeline = new RetentionTimeline(() => now);

  timeline.touch('session');
  now = 1_099;
  assert.equal(timeline.isExpired('session', 100), false);
  now = 1_100;
  assert.equal(timeline.isExpired('session', 100), true);

  timeline.touch('session');
  now = 1_199;
  assert.equal(timeline.isExpired('session', 100), false);
});

test('retention capacity selects the oldest injected timestamp', () => {
  let now = 10;
  const timeline = new RetentionTimeline(() => now);
  timeline.touch('first');
  now = 11;
  timeline.touch('second');

  assert.deepEqual(
    timeline.oldest([
      { sessionId: 'second', playerId: 'player-2' },
      { sessionId: 'first', playerId: 'player-1' },
    ]),
    { sessionId: 'first', playerId: 'player-1' },
  );
});

test('shared deadline policy expires correspondent hints at the configured boundary', () => {
  assert.equal(deadlineReached(1_000, 20, 1_019), false);
  assert.equal(deadlineReached(1_000, 20, 1_020), true);
});
