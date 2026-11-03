import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { fundingShortfall, isBuyOrderSubmitted, WalletTopUp } from '../../components/WalletTopUp';

describe('fundingShortfall', () => {
  it('counts the opening fee on top of the buy-in', () => {
    expect(fundingShortfall(1000n, '900', 200n)).toBe(100n);
    expect(fundingShortfall(1100n, '900', 200n)).toBe(0n);
  });

  it('never blocks on a balance that has not loaded', () => {
    expect(fundingShortfall(undefined, '900', 200n)).toBe(0n);
  });
});

describe('isBuyOrderSubmitted', () => {
  const origin = 'https://vault.chia.net';
  const popup = {} as Window;
  const submitted = { type: 'chia-cloud-wallet/buy-order', status: 'submitted' };

  it('accepts the purchase page message from the popup this window opened', () => {
    expect(isBuyOrderSubmitted({ origin, source: popup, data: submitted }, origin, popup)).toBe(
      true,
    );
  });

  it('ignores the message from another origin or another window', () => {
    expect(
      isBuyOrderSubmitted(
        { origin: 'https://evil.example', source: popup, data: submitted },
        origin,
        popup,
      ),
    ).toBe(false);
    expect(
      isBuyOrderSubmitted({ origin, source: {} as Window, data: submitted }, origin, popup),
    ).toBe(false);
    expect(isBuyOrderSubmitted({ origin, source: popup, data: submitted }, origin, null)).toBe(
      false,
    );
  });

  it('ignores other Cloud Wallet messages and malformed data', () => {
    const others: unknown[] = [
      { type: 'chia-cloud-wallet/signature-request', status: 'approved' },
      { type: 'chia-cloud-wallet/buy-order', status: 'failed' },
      'chia-cloud-wallet/buy-order',
      null,
    ];
    for (const data of others) {
      expect(isBuyOrderSubmitted({ origin, source: popup, data }, origin, popup)).toBe(false);
    }
  });
});

describe('WalletTopUp Buy', () => {
  const BUY_URL = 'https://vault.chia.net/buy-xch?walletId=Wallet_abc';
  const options = { buyUrl: BUY_URL, depositAddress: null };
  const originalWindow = globalThis.window;
  let renderer: ReactTestRenderer | null = null;
  let win: EventTarget & Record<string, unknown>;

  beforeEach(() => {
    win = Object.assign(new EventTarget(), {
      screenX: 0,
      screenY: 0,
      outerWidth: 1200,
      outerHeight: 900,
    });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  });

  afterEach(() => {
    if (renderer) act(() => renderer?.unmount());
    renderer = null;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  });

  function render(): ReactTestRenderer {
    act(() => {
      renderer = create(<WalletTopUp options={options} shortfall={100n} />);
    });
    return renderer!;
  }

  function text(r: ReactTestRenderer): string {
    const collect = (node: ReactTestInstance | string): string =>
      typeof node === 'string' ? node : node.children.map(collect).join('');
    return collect(r.root);
  }

  async function clickBuy(r: ReactTestRenderer): Promise<void> {
    const buy = r.root.find(
      (node) => node.type === 'button' && text({ root: node } as ReactTestRenderer) === 'Buy XCH',
    );
    await act(async () => {
      buy.props.onClick();
    });
  }

  function postMessage(origin: string, source: unknown, data: unknown): void {
    const event = Object.assign(new Event('message'), { origin, source, data });
    act(() => {
      win.dispatchEvent(event);
    });
  }

  it('opens a popup and shows the purchase once that popup reports it', async () => {
    const popup = {};
    const open = jest.fn(() => popup);
    win.open = open;
    const r = render();

    await clickBuy(r);
    expect(open).toHaveBeenCalledWith(
      BUY_URL,
      'chia-gaming-cloud-wallet-buy',
      expect.stringContaining('popup=yes'),
    );

    const submitted = { type: 'chia-cloud-wallet/buy-order', status: 'submitted' };
    postMessage('https://evil.example', popup, submitted);
    postMessage('https://vault.chia.net', {}, submitted);
    expect(text(r)).not.toContain('Purchase placed');

    postMessage('https://vault.chia.net', popup, submitted);
    expect(text(r)).toContain('Purchase placed.');
  });

  it('says so when the browser blocks the popup', async () => {
    win.open = jest.fn(() => null);
    const r = render();
    await clickBuy(r);
    expect(text(r)).toContain('blocked the Cloud Wallet window');
  });

  it('opens the system browser on desktop and reports a failure to open it', async () => {
    const openInBrowser = jest.fn(async () => true);
    win.__chiaCloudWallet = { openInBrowser };
    win.open = jest.fn();
    const r = render();

    await clickBuy(r);
    expect(openInBrowser).toHaveBeenCalledWith(BUY_URL);
    expect(win.open).not.toHaveBeenCalled();
    expect(text(r)).toContain('Finish the purchase in your browser.');

    openInBrowser.mockResolvedValueOnce(false);
    await clickBuy(r);
    expect(text(r)).toContain('Could not open your browser.');
  });
});
