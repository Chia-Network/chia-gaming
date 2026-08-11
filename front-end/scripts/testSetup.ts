(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof globalThis.localStorage === 'undefined') {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, String(value)),
    } satisfies Storage,
  });
}

const originalConsoleError = console.error;
const reactTestRendererDeprecation =
  'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer';
let unexpectedConsoleErrors: unknown[][] = [];
let expectedConsoleErrors: Array<string | RegExp> = [];

export function expectConsoleError(pattern: string | RegExp): void {
  expectedConsoleErrors.push(pattern);
}

function consoleArgumentsText(args: unknown[]): string {
  return args.map(formatConsoleArgument).join(' ');
}

function strictConsoleError(...args: unknown[]): void {
  if (args[0] === reactTestRendererDeprecation) return;
  const text = consoleArgumentsText(args);
  const expectedIndex = expectedConsoleErrors.findIndex((pattern) =>
    typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text),
  );
  if (expectedIndex >= 0) {
    expectedConsoleErrors.splice(expectedIndex, 1);
    return;
  }
  unexpectedConsoleErrors.push(args);
}

function formatConsoleArgument(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

beforeEach(() => {
  unexpectedConsoleErrors = [];
  expectedConsoleErrors = [];
  console.error = strictConsoleError;
});

afterEach(() => {
  if (jest.isMockFunction(console.error)) {
    (console.error as jest.Mock).mockRestore();
  }
  console.error = strictConsoleError;
  if (unexpectedConsoleErrors.length === 0 && expectedConsoleErrors.length === 0) return;
  const messages = unexpectedConsoleErrors.map(consoleArgumentsText).join('\n\n');
  const missing = expectedConsoleErrors.map(String).join('\n');
  unexpectedConsoleErrors = [];
  expectedConsoleErrors = [];
  throw new Error(
    [
      messages ? `Unexpected console.error during test:\n\n${messages}` : '',
      missing ? `Expected console.error did not occur:\n\n${missing}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
});

afterAll(() => {
  console.error = originalConsoleError;
});
