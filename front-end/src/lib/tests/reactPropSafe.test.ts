import { isDenseNumericByteObject, reactPropSafeValue } from '../reactPropSafe';

describe('reactPropSafeValue', () => {
  it('preserves Uint8Array game-session bytes instead of expanding them into a plain object', () => {
    const gameSession = new Uint8Array([1, 2, 3, 255]);
    const save = {
      pairingToken: 'tok',
      gameSessionSchemaVersion: 2n,
      serializedGameSession: gameSession,
      unackedMessages: [{ msgno: 4n, msg: new Uint8Array([9, 8, 7]) }],
    };

    const safe = reactPropSafeValue(save);

    expect(safe.serializedGameSession).toBeInstanceOf(Uint8Array);
    expect(safe.serializedGameSession).toEqual(gameSession);
    expect(safe.serializedGameSession).toBe(gameSession);
    expect(safe.unackedMessages?.[0].msg).toBeInstanceOf(Uint8Array);
    expect(safe.unackedMessages?.[0].msg).toEqual(new Uint8Array([9, 8, 7]));
    expect(safe.gameSessionSchemaVersion).toBe(2n);
    expect(Object.keys(safe)).not.toContain('gameSessionSchemaVersion');
  });

  it('would have produced a plain object before the typed-array guard (regression shape)', () => {
    const gameSession = new Uint8Array([10, 20, 30]);
    // Demonstrate the broken transformation that caused WASM EOF on restore.
    const broken = { ...gameSession } as Record<string, unknown>;
    expect(broken).toEqual({ 0: 10, 1: 20, 2: 30 });
    expect(ArrayBuffer.isView(broken)).toBe(false);
    expect((broken as { length?: number }).length).toBeUndefined();
  });

  it('does not deep-clone a large degraded numeric-keyed byte object', () => {
    const degraded: Record<string, number> = {};
    for (let i = 0; i < 5000; i++) degraded[String(i)] = i & 0xff;
    expect(isDenseNumericByteObject(degraded)).toBe(true);

    const save = { pairingToken: 'tok', serializedGameSession: degraded };
    const safe = reactPropSafeValue(save);
    expect(safe.serializedGameSession).toBe(degraded);
  });
});
