import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Profiler, useEffect, type ReactElement } from 'react';
import { SETUP_2048_SLIDE_MS, Setup2048Provider } from '../../components/Setup2048';
import { SessionTransitionSurface } from '../../components/SessionTransitionSurface';
import type { Setup2048Direction } from '../setup2048';

// Complete legal runs from two initial 2s, always choosing the first empty cell
// and a 2 unless the forced-4 rule applies. No solver is included in the app.
const WINNING_RUN =
  'left right down right left right up right left up left right left up right right left left right up left right left down left up right right left left right down left up left right left up right right left left right up right right right right up left down left left left down left left left down left up down left right up left'.split(
    ' ',
  ) as Setup2048Direction[];
const LOSING_RUN = 'left right down right left up up'.split(' ') as Setup2048Direction[];

describe('setup challenge UI', () => {
  let renderer: ReactTestRenderer;
  let random: jest.SpyInstance;
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const priorStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    Object.defineProperty(globalThis, 'getComputedStyle', {
      configurable: true,
      value: () => ({ visibility: 'visible' }),
    });
    random = jest.spyOn(Math, 'random').mockReturnValue(0);
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { activeElement: null },
    });
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    random.mockRestore();
    for (const [name, descriptor] of [
      ['window', priorWindow],
      ['getComputedStyle', priorStyle],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    jest.useRealTimers();
    if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  const mount = (element: ReactElement) =>
    create(element, {
      createNodeMock: (node) =>
        node.props.role === 'grid' ? { getClientRects: () => [{}], focus: jest.fn() } : null,
    });
  const board = () =>
    renderer.root.findAllByProps({ role: 'gridcell' }).map((cell) => cell.props['aria-label']);
  const tiles = () =>
    renderer.root.findAll((node) => typeof node.props['data-setup-tile-id'] === 'number');
  const buttons = () =>
    renderer.root.findAllByType('button').map((button) => button.children.join(''));
  const click = (label: string) =>
    act(() =>
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.join('') === label)!
        .props.onClick(),
    );
  const move = (direction: Setup2048Direction) => {
    act(() => renderer.root.findByProps({ 'aria-label': `Move ${direction}` }).props.onClick());
    act(() => jest.advanceTimersByTime(SETUP_2048_SLIDE_MS));
  };
  const render = (mounted: boolean, attemptKey = 'first-attempt') => (
    <Setup2048Provider attemptKey={attemptKey}>
      {mounted ? (
        <div>
          <SessionTransitionSurface />
        </div>
      ) : (
        <SessionTransitionSurface />
      )}
    </Setup2048Provider>
  );
  const start = () =>
    act(() => {
      renderer = mount(render(false));
    });

  it('has no undo or restart controls during a run', () => {
    start();
    expect(buttons()).not.toContain('Undo');
    expect(buttons()).not.toContain('New game');
    expect(buttons()).not.toContain('Play again');
    expect(buttons()).not.toContain('Keep playing');
  });

  it('slides the same tiles before replacing a merging pair, and ignores overlapping input', () => {
    start();
    const initialIds = tiles().map((tile) => tile.props['data-setup-tile-id']);
    const before = board();
    act(() => renderer.root.findByProps({ 'aria-label': 'Move right' }).props.onClick());
    expect(tiles().map((tile) => tile.props['data-setup-tile-id'])).toEqual(initialIds);
    expect(tiles().every((tile) => tile.props.style.left === 'calc(2 * (100% + 0.6rem) / 3)')).toBe(
      true,
    );
    expect(board()).toEqual(before);
    expect(renderer.root.findByProps({ role: 'grid' }).props['aria-busy']).toBe(true);
    act(() => renderer.root.findByProps({ 'aria-label': 'Move down' }).props.onClick());
    act(() => jest.advanceTimersByTime(SETUP_2048_SLIDE_MS - 1));
    expect(board()).toEqual(before);
    act(() => jest.advanceTimersByTime(1));
    expect(board()).toEqual([
      'Row 1, column 1: 2',
      'Row 1, column 2: empty',
      'Row 1, column 3: 4',
      'Row 2, column 1: empty',
      'Row 2, column 2: empty',
      'Row 2, column 3: empty',
    ]);
    expect(renderer.root.findByProps({ role: 'grid' }).props['aria-busy']).toBe(false);
  });

  it('plays a complete 66-move run to 128 and keeps playing without a prompt', () => {
    start();
    for (const direction of WINNING_RUN) move(direction);
    expect(board().some((cell) => cell.endsWith(': 128'))).toBe(true);
    expect(renderer.root.findByProps({ role: 'status' }).children.join('')).toBe(
      'You did it! See how far you can get!',
    );
    expect(buttons()).not.toContain('Play again');
    expect(buttons()).not.toContain('Keep playing');
    const continued = board();
    move('right');
    expect(board()).not.toEqual(continued);
    expect(renderer.root.findByProps({ role: 'status' }).children.join('')).toBe(
      'You did it! See how far you can get!',
    );
  });

  it('offers only Play again when a complete run gets stuck', () => {
    start();
    const before = board();
    for (const direction of LOSING_RUN) move(direction);
    expect(buttons()).toContain('Play again');
    expect(buttons()).not.toContain('Keep playing');
    click('Play again');
    expect(board()).toEqual(before);
  });

  it('preserves the board when setup moves into GameSession', () => {
    start();
    move('left');
    const moved = board();
    act(() => renderer.update(render(true)));
    expect(board()).toEqual(moved);
  });

  it('never commits the previous board when a new attempt becomes visible', () => {
    const committedBoards: string[][] = [];
    let recording = false;
    const attempt = (attemptKey: string) => (
      <Setup2048Provider attemptKey={attemptKey}>
        <Profiler
          id="setup-board"
          onRender={() => {
            if (recording) committedBoards.push(board());
          }}
        >
          <SessionTransitionSurface />
        </Profiler>
      </Setup2048Provider>
    );
    act(() => {
      renderer = mount(attempt('first'));
    });
    const fresh = board();
    move('left');
    expect(board()).not.toEqual(fresh);
    recording = true;
    act(() => renderer.update(attempt('second')));
    expect(committedBoards.length).toBeGreaterThan(0);
    for (const committed of committedBoards) expect(committed).toEqual(fresh);
  });

  it('resets an attempt mid-animation without remounting the session or applying a stale move', () => {
    let mounts = 0;
    function Session() {
      useEffect(() => {
        mounts++;
      }, []);
      return <SessionTransitionSurface />;
    }
    const attempt = (attemptKey: string) => (
      <Setup2048Provider attemptKey={attemptKey}>
        <Session />
      </Setup2048Provider>
    );
    act(() => {
      renderer = mount(attempt('first'));
    });
    const before = board();
    act(() => renderer.root.findByProps({ 'aria-label': 'Move left' }).props.onClick());
    act(() => renderer.update(attempt('second')));
    act(() => jest.advanceTimersByTime(SETUP_2048_SLIDE_MS));
    expect(board()).toEqual(before);
    expect(mounts).toBe(1);
  });

  it('takes default keyboard input without clicking and leaves modified shortcuts alone', () => {
    start();
    const before = board();
    const modified = Object.assign(new Event('keydown', { cancelable: true }), {
      key: 'ArrowRight',
      ctrlKey: true,
    });
    act(() => {
      window.dispatchEvent(modified);
    });
    expect(modified.defaultPrevented).toBe(false);
    expect(board()).toEqual(before);
    const key = Object.assign(new Event('keydown', { cancelable: true }), { key: 'ArrowRight' });
    act(() => {
      window.dispatchEvent(key);
    });
    act(() => jest.advanceTimersByTime(SETUP_2048_SLIDE_MS));
    expect(board()).not.toEqual(before);
    expect(key.defaultPrevented).toBe(true);
  });

  it('leaves text fields and dialogs in control and ignores the hidden game tab', () => {
    start();
    const before = board();
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { activeElement: { closest: () => ({}) } },
    });
    const inputKey = Object.assign(new Event('keydown', { cancelable: true }), {
      key: 'ArrowRight',
    });
    act(() => {
      window.dispatchEvent(inputKey);
    });
    expect(inputKey.defaultPrevented).toBe(false);
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { activeElement: null },
    });
    Object.defineProperty(globalThis, 'getComputedStyle', {
      configurable: true,
      value: () => ({ visibility: 'hidden' }),
    });
    const hiddenKey = Object.assign(new Event('keydown', { cancelable: true }), {
      key: 'ArrowRight',
    });
    act(() => {
      window.dispatchEvent(hiddenKey);
    });
    expect(hiddenKey.defaultPrevented).toBe(false);
    act(() => jest.advanceTimersByTime(SETUP_2048_SLIDE_MS));
    expect(board()).toEqual(before);
  });

  it('accepts swipes', () => {
    start();
    const before = board();
    const currentTarget = { focus: jest.fn(), setPointerCapture: jest.fn() };
    act(() =>
      renderer.root.findByProps({ role: 'grid' }).props.onPointerDown({
        isPrimary: true,
        button: 0,
        currentTarget,
        pointerId: 1,
        clientX: 100,
        clientY: 50,
      }),
    );
    act(() =>
      renderer.root.findByProps({ role: 'grid' }).props.onPointerUp({ clientX: 0, clientY: 50 }),
    );
    act(() => jest.advanceTimersByTime(SETUP_2048_SLIDE_MS));
    expect(board()).not.toEqual(before);
  });
});
