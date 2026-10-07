import {
  moveSetup2048,
  newSetup2048Board,
  setup2048Status,
  slideSetup2048,
  spawnSetup2048,
  type Setup2048Direction,
} from '../setup2048';

describe('2x3 setup challenge', () => {
  it.each([
    ['left', [2, 0, 2, 4, 4, 4], [4, 0, 0, 8, 4, 0]],
    ['right', [2, 0, 2, 4, 4, 4], [0, 0, 4, 0, 4, 8]],
    ['up', [2, 0, 4, 2, 4, 4], [4, 4, 8, 0, 0, 0]],
    ['down', [2, 0, 4, 2, 4, 4], [0, 0, 0, 4, 4, 8]],
  ] as [Setup2048Direction, number[], number[]][])(
    'slides and merges %s without merging a tile twice',
    (direction, board, expected) => {
      const original = [...board];
      expect(slideSetup2048(board, direction)).toEqual(expected);
      expect(board).toEqual(original);
    },
  );

  it('does not spawn a tile or consume an undo turn for an ineffective move', () => {
    const board = [2, 4, 0, 0, 0, 0];
    expect(moveSetup2048(board, 'left', 0.99, 0.99)).toBe(board);
  });

  it('spawns exactly once after a move', () => {
    expect(moveSetup2048([2, 0, 0, 0, 0, 0], 'right', 0, 0)).toEqual([2, 0, 2, 0, 0, 0]);
  });

  it('uses the original 90/10 spawn distribution and only empty cells', () => {
    expect(spawnSetup2048([2, 0, 8, 0, 16, 32], 0, 0.899)).toEqual([2, 2, 8, 0, 16, 32]);
    expect(spawnSetup2048([2, 0, 8, 0, 16, 32], 0.999, 0.9)).toEqual([2, 0, 8, 4, 16, 32]);
  });

  it.each(Array.from({ length: 6 }, (_, index) => index))(
    'forces the necessary 4 regardless of the empty cell position (%s)',
    (emptyIndex) => {
      const board = [64, 32, 16, 8, 4];
      board.splice(emptyIndex, 0, 0);
      const next = spawnSetup2048(board, 0.5, 0);
      expect(next[emptyIndex]).toBe(4);
      expect(next.reduce((sum, value) => sum + value, 0)).toBe(128);
    },
  );

  it('does not force a 4 just because some large tiles are present', () => {
    expect(spawnSetup2048([64, 32, 16, 8, 0, 0], 0, 0)).toEqual([64, 32, 16, 8, 2, 0]);
  });

  it('reaches 128, spawns normally, and allows play to continue', () => {
    const won = moveSetup2048([64, 64, 0, 0, 0, 0], 'left', 0, 0);
    expect(won).toEqual([128, 2, 0, 0, 0, 0]);
    expect(setup2048Status(won)).toBe('playing');
    expect(moveSetup2048(won, 'right', 0, 0)).toEqual([2, 128, 2, 0, 0, 0]);
  });

  it('distinguishes a full movable board from game over', () => {
    expect(setup2048Status([2, 4, 8, 16, 32, 64])).toBe('over');
    expect(setup2048Status([2, 4, 8, 2, 32, 64])).toBe('playing');
    const over = [2, 4, 8, 16, 32, 64];
    expect(moveSetup2048(over, 'left', 0, 0)).toBe(over);
  });

  it('starts with two independently spawned tiles', () => {
    const random = jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      expect(newSetup2048Board()).toEqual([2, 2, 0, 0, 0, 0]);
    } finally {
      random.mockRestore();
    }
  });
});
