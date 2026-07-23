import { createFrozenHandBridge } from '../../hooks/frozenHandBridge';

describe('frozen hand bridge', () => {
  it('reports terminal hand-state writes for persistence', () => {
    const initial = { gameType: 'calpoker', version: 1n, state: { turn: 'initial' } };
    const terminal = { gameType: 'calpoker', version: 1n, state: { turn: 'ended' } };
    const persisted: unknown[] = [];
    const bridge = createFrozenHandBridge(initial, state => persisted.push(state));

    bridge.setHandState(terminal);

    expect(bridge.handState).toEqual(terminal);
    expect(persisted).toEqual([terminal]);
  });
});
