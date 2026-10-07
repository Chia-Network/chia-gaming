// Adapted from bramcohen/2048's public-domain 2x3 game:
// https://github.com/bramcohen/2048/blob/07e5cf8a6ec909d0e8e58d9fa34523b6cb115d4c/2048-2x3.html
// Only tile movement and spawning are needed here; no probability solver.
export type Setup2048Direction = 'up' | 'down' | 'left' | 'right';
export type Setup2048Board = readonly number[];
export const SETUP_2048_DIRECTIONS: Setup2048Direction[] = ['up', 'down', 'left', 'right'];

export function slideSetup2048(
  board: Setup2048Board,
  direction: Setup2048Direction,
): Setup2048Board {
  return planSetup2048Slide(board, direction).board;
}

export function planSetup2048Slide(board: Setup2048Board, direction: Setup2048Direction) {
  const next = [...board];
  const destinations = board.map((_, index) => index);
  const horizontal = direction === 'left' || direction === 'right';
  const lines = horizontal ? 2 : 3;
  const length = horizontal ? 3 : 2;
  for (let line = 0; line < lines; line++) {
    const indices = Array.from({ length }, (_, offset) => {
      const position = direction === 'right' || direction === 'down' ? length - 1 - offset : offset;
      return horizontal ? line * 3 + position : position * 3 + line;
    });
    const values = indices.filter((index) => board[index] !== 0);
    const merged: number[] = [];
    for (let i = 0; i < values.length; i++) {
      const destination = indices[merged.length];
      destinations[values[i]] = destination;
      if (i + 1 < values.length && board[values[i]] === board[values[i + 1]]) {
        destinations[values[i + 1]] = destination;
        merged.push(board[values[i]] * 2);
        i++;
      } else {
        merged.push(board[values[i]]);
      }
    }
    indices.forEach((index, offset) => {
      next[index] = merged[offset] ?? 0;
    });
  }
  return {
    board: next.every((value, index) => value === board[index]) ? board : next,
    destinations,
  };
}

export function spawnSetup2048(
  board: Setup2048Board,
  positionRandom: number,
  valueRandom: number,
): Setup2048Board {
  const empty = board.flatMap((value, index) => (value === 0 ? [index] : []));
  if (empty.length === 0) return board;
  const next = [...board];
  // A 2 would make 128 impossible with just six cells in this configuration.
  const needsFour = [64, 32, 16, 8, 4].every((value) => board.includes(value));
  next[empty[Math.floor(positionRandom * empty.length)]] = needsFour || valueRandom >= 0.9 ? 4 : 2;
  return next;
}

export function newSetup2048Board(): Setup2048Board {
  return spawnSetup2048(
    spawnSetup2048([0, 0, 0, 0, 0, 0], Math.random(), Math.random()),
    Math.random(),
    Math.random(),
  );
}

export function setup2048Status(board: Setup2048Board): 'playing' | 'over' {
  return SETUP_2048_DIRECTIONS.some((direction) => slideSetup2048(board, direction) !== board)
    ? 'playing'
    : 'over';
}

export function moveSetup2048(
  board: Setup2048Board,
  direction: Setup2048Direction,
  positionRandom: number,
  valueRandom: number,
): Setup2048Board {
  if (setup2048Status(board) !== 'playing') return board;
  const next = slideSetup2048(board, direction);
  if (next === board) return next;
  return spawnSetup2048(next, positionRandom, valueRandom);
}
