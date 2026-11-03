import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import {
  _resetBuyPopupForTests,
  fundingShortfall,
  isBuyOrderSubmitted,
  WalletTopUp,
} from '../../components/WalletTopUp';

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
    _resetBuyPopupForTests();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  });

  function render(): ReactTestRenderer {
    act(() => {
      renderer = create(<WalletTopUp options={options} shortfall={100n} />);
    });
    return renderer!;
  }

  /** The Wallet tab and the New Session dialog each mount a WalletTopUp at once. */
  function renderTwo(): [ReactTestRenderer, ReactTestRenderer] {
    act(() => {
      renderer = create(
        <>
          <WalletTopUp options={options} shortfall={0n} />
          <WalletTopUp options={options} shortfall={100n} />
        </>,
      );
    });
    const [walletTab, dialog] = renderer!.root.findAllByType(WalletTopUp);
    const asRenderer = (root: ReactTestInstance) => ({ root }) as ReactTestRenderer;
    return [asRenderer(walletTab!), asRenderer(dialog!)];
  }

  function textOf(node: ReactTestInstance | string): string {
    return typeof node === 'string' ? node : node.children.map(textOf).join('');
  }

  function text(r: ReactTestRenderer): string {
    return textOf(r.root);
  }

  async function clickBuy(r: ReactTestRenderer): Promise<void> {
    const buy = r.root.find((node) => node.type === 'button' && textOf(node) === 'Buy XCH');
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
    const popup = { closed: false, focus: jest.fn() };
    const open = jest.fn(() => popup);
    win.open = open;
    const r = render();

    await clickBuy(r);
    expect(open).toHaveBeenCalledWith(
      BUY_URL,
      'chia-gaming-cloud-wallet-buy',
      expect.stringContaining('popup=yes'),
    );
    // A second click brings back the open purchase instead of reloading it.
    await clickBuy(r);
    expect(open).toHaveBeenCalledTimes(1);
    expect(popup.focus).toHaveBeenCalledTimes(1);

    const submitted = { type: 'chia-cloud-wallet/buy-order', status: 'submitted' };
    postMessage('https://evil.example', popup, submitted);
    postMessage('https://vault.chia.net', {}, submitted);
    expect(text(r)).not.toContain('Purchase placed');

    postMessage('https://vault.chia.net', popup, submitted);
    expect(text(r)).toContain('Purchase placed.');
  });

  it('shares one buy window between the Wallet tab and the New Session dialog', async () => {
    const popup = { closed: false, focus: jest.fn() };
    const open = jest.fn(() => popup);
    win.open = open;
    const [walletTab, dialog] = renderTwo();

    await clickBuy(walletTab);
    // Buy in the dialog brings back the purchase the tab opened instead of reloading it.
    await clickBuy(dialog);
    expect(open).toHaveBeenCalledTimes(1);
    expect(popup.focus).toHaveBeenCalledTimes(1);

    // The dialog reports a purchase made in the window the tab opened.
    postMessage('https://vault.chia.net', popup, {
      type: 'chia-cloud-wallet/buy-order',
      status: 'submitted',
    });
    expect(textOf(dialog.root)).toContain('Purchase placed.');
  });

  it('opens a new buy window once the previous one was closed', async () => {
    const first = { closed: false, focus: jest.fn() };
    const second = { closed: false, focus: jest.fn() };
    const open = jest.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    win.open = open;
    const r = render();

    await clickBuy(r);
    first.closed = true;
    await clickBuy(r);
    expect(open).toHaveBeenCalledTimes(2);
    expect(first.focus).not.toHaveBeenCalled();
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
