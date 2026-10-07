import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  moveSetup2048,
  newSetup2048Board,
  planSetup2048Slide,
  setup2048Status,
  type Setup2048Board,
  type Setup2048Direction,
} from '../lib/setup2048';
import { Button } from './button';

export const SETUP_2048_SLIDE_MS = 150;
type Tile = { id: number; index: number; value: number; appearance?: 'new' | 'merged' };
type Game = {
  attemptKey: string | null;
  board: Setup2048Board;
  tiles: Tile[];
  nextId: number;
  pending: { board: Setup2048Board; tiles: Tile[]; nextId: number } | null;
};

function freshGame(attemptKey: string | null): Game {
  const board = newSetup2048Board();
  const tiles = board.flatMap((value, index) =>
    value ? [{ id: index, index, value, appearance: 'new' as const }] : [],
  );
  return { attemptKey, board, tiles, nextId: 6, pending: null };
}

function finishTiles(board: Setup2048Board, movedTiles: Tile[], nextId: number) {
  const tiles = board.flatMap<Tile>((value, index) => {
    if (!value) return [];
    const sources = movedTiles.filter((tile) => tile.index === index);
    if (sources.length === 1) return [{ ...sources[0], appearance: undefined }];
    return [{ id: nextId++, index, value, appearance: sources.length === 2 ? 'merged' : 'new' }];
  });
  return { board, tiles, nextId };
}

const Setup2048Context = createContext<{
  game: Game;
  move: (direction: Setup2048Direction) => void;
  restart: () => void;
} | null>(null);

// Shell owns this state so mounting GameSession does not restart the run.
export function Setup2048Provider({
  children,
  attemptKey,
}: {
  children: ReactNode;
  attemptKey: string | null;
}) {
  const [game, setGame] = useState<Game>(() => freshGame(attemptKey));
  // Reset this provider before rendering children, so a new attempt cannot
  // commit the previous board. Keep the session children mounted.
  if (game.attemptKey !== attemptKey) setGame(freshGame(attemptKey));
  const pending = game.pending;
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      setGame((current) =>
        current.pending === pending ? { ...current, ...pending, pending: null } : current,
      );
    }, SETUP_2048_SLIDE_MS);
    return () => clearTimeout(timer);
  }, [pending]);
  const move = (direction: Setup2048Direction) => {
    const positionRandom = Math.random();
    const valueRandom = Math.random();
    setGame((current) => {
      if (current.pending) return current;
      const board = moveSetup2048(current.board, direction, positionRandom, valueRandom);
      if (board === current.board) return current;
      const { destinations } = planSetup2048Slide(current.board, direction);
      const tiles = current.tiles.map((tile) => ({
        ...tile,
        index: destinations[tile.index],
        appearance: undefined,
      }));
      return { ...current, tiles, pending: finishTiles(board, tiles, current.nextId) };
    });
  };
  const restart = () => setGame(freshGame(attemptKey));
  return (
    <Setup2048Context.Provider value={{ game, move, restart }}>
      {children}
    </Setup2048Context.Provider>
  );
}

const arrows: Record<Setup2048Direction, string> = { up: '↑', down: '↓', left: '←', right: '→' };
const keys: Record<string, Setup2048Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

export function Setup2048() {
  const context = useContext(Setup2048Context);
  if (!context) throw new Error('Setup2048 requires Setup2048Provider');
  const { game, move, restart } = context;
  const boardRef = useRef<HTMLDivElement>(null);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const status = setup2048Status(game.board);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      // The challenge is the default input while visible, except when a wallet
      // dialog, notification, or editable field owns the keyboard.
      const board = boardRef.current;
      if (
        !board ||
        board.getClientRects().length === 0 ||
        getComputedStyle(board).visibility === 'hidden'
      )
        return;
      if (
        document.activeElement?.closest(
          '[role="dialog"], [data-between-hand-focus-boundary], input, textarea, select, [contenteditable="true"]',
        )
      )
        return;
      const direction = keys[event.key];
      if (direction) {
        event.preventDefault();
        move(direction);
      } else if (event.key === 'Enter' && status === 'over') {
        event.preventDefault();
        restart();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [move, restart, status]);

  return (
    <section
      className="setup-2048 flex flex-col items-center gap-3 text-center"
      aria-label="2048 setup challenge"
    >
      <h2 className="text-lg font-semibold">Can you get 128 before the channel is set up?</h2>
      <div
        ref={boardRef}
        role="grid"
        aria-label="2048 board. Use arrow keys or swipe to move tiles."
        tabIndex={0}
        aria-busy={game.pending !== null}
        className="setup-2048-board"
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          swipeStart.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerCancel={() => {
          swipeStart.current = null;
        }}
        onPointerUp={(event) => {
          const start = swipeStart.current;
          swipeStart.current = null;
          if (!start) return;
          const dx = event.clientX - start.x;
          const dy = event.clientY - start.y;
          if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
          move(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
        }}
      >
        {[0, 1].map((row) => (
          <div role="row" className="setup-2048-row" key={row}>
            {game.board.slice(row * 3, row * 3 + 3).map((value, col) => (
              <div
                role="gridcell"
                key={col}
                aria-label={`Row ${row + 1}, column ${col + 1}: ${value || 'empty'}`}
                className="setup-2048-cell"
              />
            ))}
          </div>
        ))}
        <div className="setup-2048-tiles" aria-hidden="true">
          {game.tiles.map((tile) => (
            <div
              key={tile.id}
              data-setup-tile-id={tile.id}
              className="setup-2048-tile-position"
              style={{
                left: `calc(${tile.index % 3} * (100% + 0.6rem) / 3)`,
                top: `calc(${Math.floor(tile.index / 3)} * (100% + 0.6rem) / 2)`,
              }}
            >
              <span
                className={`setup-2048-tile setup-2048-tile-${tile.value}${tile.appearance ? ` setup-2048-${tile.appearance}` : ''}`}
                style={{ background: tile.value > 128 ? '#edcc61' : undefined }}
              >
                {tile.value}
              </span>
            </div>
          ))}
        </div>
      </div>
      <p role="status" className="text-sm" aria-live="polite">
        {status === 'over'
          ? 'No moves left. Try again!'
          : game.board.some((value) => value >= 128)
            ? 'You did it! See how far you can get!'
            : 'Combine matching tiles to reach 128.'}
      </p>
      {status === 'over' && !game.pending ? (
        <div className="flex gap-2" role="group" aria-label="No moves left">
          <Button
            size="sm"
            color="neutral"
            variant="surface"
            onClick={() => {
              restart();
              boardRef.current?.focus({ preventScroll: true });
            }}
          >
            Play again
          </Button>
        </div>
      ) : (
        <div className="flex gap-2" role="group" aria-label="Move tiles">
          {(['left', 'up', 'down', 'right'] as const).map((direction) => (
            <Button
              key={direction}
              size="sm"
              color="neutral"
              variant="surface"
              aria-label={`Move ${direction}`}
              disabled={status !== 'playing' || game.pending !== null}
              onClick={() => {
                move(direction);
                boardRef.current?.focus({ preventScroll: true });
              }}
            >
              {arrows[direction]}
            </Button>
          ))}
        </div>
      )}
      <p className="text-xs text-canvas-solid">Arrow keys, swipe, or tap the arrows.</p>
    </section>
  );
}
