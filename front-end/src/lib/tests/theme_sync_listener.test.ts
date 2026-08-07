import installThemeSyncListener from '../../utils/themeSyncListener';

type Handler = (ev: MessageEvent) => void;

function setTestGlobal(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

function clearTestGlobal(key: string) {
  Reflect.deleteProperty(globalThis, key);
}

type Harness = {
  handler: Handler;
  applied: Record<string, string>;
  classes: Set<string>;
  /** The window the listener sees as its embedder. Equals the window itself when top-level. */
  parent: unknown;
};

/**
 * Installs the listener against a fake window. When `embedded` is false the
 * window is its own parent, which is how a real top-level document reports.
 */
function install(embedded: boolean): Harness {
  const applied: Record<string, string> = {};
  const classes = new Set<string>();
  let handler: Handler = () => {};

  const fakeWindow: Record<string, unknown> = {
    addEventListener: (_type: string, h: Handler) => {
      handler = h;
    },
    removeEventListener: () => {},
  };
  fakeWindow.parent = embedded ? { frame: 'parent' } : fakeWindow;

  setTestGlobal('window', fakeWindow);
  setTestGlobal('document', {
    documentElement: {
      style: {
        setProperty: (k: string, v: string) => {
          applied[k] = v;
        },
      },
      classList: {
        add: (c: string) => classes.add(c),
        remove: (c: string) => classes.delete(c),
      },
    },
  });

  installThemeSyncListener();
  return { handler: (ev) => handler(ev), applied, classes, parent: fakeWindow.parent };
}

function themeMessage(source: unknown): MessageEvent {
  return {
    source,
    origin: 'https://hub.example.com',
    data: { type: 'theme-sync', vars: { '--canvas-bg': 'red' }, dark: true },
  } as unknown as MessageEvent;
}

afterEach(() => {
  clearTestGlobal('window');
  clearTestGlobal('document');
});

describe('installThemeSyncListener', () => {
  it('applies a theme sent by the embedder', () => {
    const h = install(true);

    h.handler(themeMessage(h.parent));

    expect(h.applied['--canvas-bg']).toBe('red');
    expect(h.classes.has('dark')).toBe(true);
  });

  it('ignores a theme from any frame that is not the embedder', () => {
    const h = install(true);

    // A sibling frame — e.g. the WalletConnect Verify frame — holding a
    // reference to this window must not be able to restyle it.
    h.handler(themeMessage({ frame: 'someone-else' }));

    expect(h.applied).toEqual({});
    expect(h.classes.has('dark')).toBe(false);
  });

  it('ignores a theme when running as the top-level document', () => {
    const h = install(false);

    h.handler(themeMessage(h.parent));

    expect(h.applied).toEqual({});
    expect(h.classes.has('dark')).toBe(false);
  });
});
