import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import {
  _resetBuyPopupForTests,
  isBuyOrderSubmitted,
  WalletTopUp,
} from '../../components/WalletTopUp';

import { fundingShortfall } from '../wallet/fundingShortfall';

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
    expect(open).toHaveBeenCalledWith(BUY_URL, '_blank', expect.stringContaining('popup=yes'));
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

  it('keeps wallet purchases in distinct windows through switches', async () => {
    const OTHER_URL = 'https://vault.chia.net/buy-xch?walletId=Wallet_other';
    // A browser returns the same WindowProxy when a named window is navigated.
    const named = new Map<string, { closed: boolean; focus: jest.Mock }>();
    const open = jest.fn((_url: string, target: string) => {
      if (target !== '_blank' && named.has(target)) return named.get(target)!;
      const popup = { closed: false, focus: jest.fn() };
      named.set(target, popup);
      return popup;
    });
    win.open = open;
    const submitted = { type: 'chia-cloud-wallet/buy-order', status: 'submitted' };
    const r = render();

    await clickBuy(r);
    const first = open.mock.results[0]!.value;
    postMessage('https://vault.chia.net', first, submitted);
    expect(text(r)).toContain('Purchase placed.');
    act(() => {
      r.update(
        <WalletTopUp options={{ buyUrl: OTHER_URL, depositAddress: null }} shortfall={100n} />,
      );
    });
    expect(text(r)).not.toContain('Purchase placed');
    await clickBuy(r);
    const second = open.mock.results[1]!.value;
    // A delayed message from the old document cannot describe the new wallet,
    // even while the new purchase page is still navigating.
    postMessage('https://vault.chia.net', first, submitted);
    expect(text(r)).not.toContain('Purchase placed');
    expect(second).not.toBe(first);
    postMessage('https://vault.chia.net', second, submitted);
    expect(text(r)).toContain('Purchase placed.');

    act(() => r.update(<WalletTopUp options={options} shortfall={0n} />));
    await clickBuy(r);
    expect(open).toHaveBeenCalledTimes(2);
    expect(first.focus).toHaveBeenCalledTimes(1);
  });

  it('retains an in-progress purchase when the wallet tab remounts', async () => {
    const popup = { closed: false, focus: jest.fn() };
    const open = jest.fn(() => popup);
    win.open = open;
    const first = render();
    await clickBuy(first);
    act(() => first.unmount());
    const remounted = render();
    await clickBuy(remounted);
    expect(open).toHaveBeenCalledTimes(1);
    expect(popup.focus).toHaveBeenCalledTimes(1);
  });

  it('hides a popup error after switching wallets', async () => {
    win.open = jest.fn(() => null);
    const r = render();
    await clickBuy(r);
    expect(text(r)).toContain('blocked the Cloud Wallet window');
    act(() => {
      r.update(
        <WalletTopUp
          options={{
            buyUrl: 'https://vault.chia.net/buy-xch?walletId=Wallet_other',
            depositAddress: null,
          }}
          shortfall={0n}
        />,
      );
    });
    expect(text(r)).not.toContain('blocked the Cloud Wallet window');
  });

  it('does not show a late desktop result for the wallet selected afterward', async () => {
    let finish!: (opened: boolean) => void;
    win.__chiaCloudWallet = {
      openInBrowser: () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    };
    const r = render();
    await clickBuy(r);
    act(() => {
      r.update(
        <WalletTopUp
          options={{
            buyUrl: 'https://vault.chia.net/buy-xch?walletId=Wallet_other',
            depositAddress: null,
          }}
          shortfall={0n}
        />,
      );
    });
    await act(async () => finish(true));
    expect(text(r)).not.toContain('Finish the purchase in your browser.');
  });

  it('ignores a purchase from a window still buying for an earlier wallet', async () => {
    const popup = { closed: false, focus: jest.fn() };
    win.open = jest.fn(() => popup);
    const r = render();
    await clickBuy(r);

    // Switched wallets, but the window still shows the earlier wallet's page.
    act(() => {
      r.update(
        <WalletTopUp
          options={{
            buyUrl: 'https://vault.chia.net/buy-xch?walletId=Wallet_other',
            depositAddress: null,
          }}
          shortfall={100n}
        />,
      );
    });
    postMessage('https://vault.chia.net', popup, {
      type: 'chia-cloud-wallet/buy-order',
      status: 'submitted',
    });
    expect(text(r)).not.toContain('Purchase placed');
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
