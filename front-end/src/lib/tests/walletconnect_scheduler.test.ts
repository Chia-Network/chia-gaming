const requestMock = jest.fn();

const relayerMock = {
  connected: true,
  on: jest.fn(),
  off: jest.fn(),
};

jest.mock('../../hooks/useWalletConnect', () => ({
  walletConnectState: {
    getClient: () => ({
      core: { relayer: relayerMock },
      request: requestMock,
      session: { keys: ['topic-1'] },
    }),
    getSession: () => ({ topic: 'topic-1' }),
    getAddress: () => '123',
    getChainId: () => 'chia:mainnet',
  },
}));

jest.mock('../../services/log', () => ({
  log: jest.fn(),
}));

import { ChiaMethod } from '../../constants/wallet-connect';
import { rpc, walletConnectScheduler } from '../../hooks/JsonRpcContext';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function advanceLane(): Promise<void> {
  await jest.advanceTimersByTimeAsync(50);
}

async function flushPromises(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
  await Promise.resolve();
  await Promise.resolve();
}

describe('WalletConnect scheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    requestMock.mockReset();
    walletConnectScheduler.resetForTests();
  });

  afterEach(() => {
    walletConnectScheduler.resetForTests();
    jest.useRealTimers();
  });

  it('serializes one-shot requests FIFO and starts the next only after settlement', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    requestMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const p1 = rpc.getHeightInfo({});
    const p2 = rpc.getWalletBalance({});

    await advanceLane();
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][0].request.method).toBe(ChiaMethod.GetHeightInfo);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(requestMock).toHaveBeenCalledTimes(1);

    first.resolve({ height: 7n, success: true });
    await advanceLane();
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[1][0].request.method).toBe(ChiaMethod.GetWalletBalance);

    second.resolve({ confirmedWalletBalance: 11n });
    await expect(p1).resolves.toMatchObject({ height: 7n });
    await expect(p2).resolves.toMatchObject({ confirmedWalletBalance: 11n });
  });

  it('does not auto-advance the lane when a WalletConnect request never settles', async () => {
    requestMock.mockReturnValueOnce(new Promise(() => {}));

    void rpc.pushTransactions({ transactions: [] });
    void rpc.getHeightInfo({});

    await advanceLane();
    await jest.advanceTimersByTimeAsync(120_000);

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][0].request.method).toBe(ChiaMethod.PushTransactions);
  });

  it('runs foreground wallet actions before queued background requests', async () => {
    const first = deferred<unknown>();
    const createOffer = deferred<unknown>();
    const selectCoins = deferred<unknown>();
    const push = deferred<unknown>();
    const balance = deferred<unknown>();
    requestMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(createOffer.promise)
      .mockReturnValueOnce(selectCoins.promise)
      .mockReturnValueOnce(push.promise)
      .mockReturnValueOnce(balance.promise);

    const p1 = rpc.getHeightInfo({});

    await advanceLane();
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][0].request.method).toBe(ChiaMethod.GetHeightInfo);

    const p2 = rpc.getWalletBalance({});
    const p3 = rpc.createOfferForIds({ offer: {}, driverDict: {} } as any);
    const p4 = rpc.selectCoins({ walletId: 1n, amount: 1n });
    const p5 = rpc.pushTransactions({ transactions: [] });

    first.resolve({ height: 7n, success: true });
    await advanceLane();
    expect(requestMock.mock.calls[1][0].request.method).toBe(ChiaMethod.CreateOfferForIds);

    createOffer.resolve({ offer: 'offer1' });
    await advanceLane();
    expect(requestMock.mock.calls[2][0].request.method).toBe(ChiaMethod.SelectCoins);

    selectCoins.resolve({ coins: [] });
    await advanceLane();
    expect(requestMock.mock.calls[3][0].request.method).toBe(ChiaMethod.PushTransactions);

    push.resolve({ success: true });
    await advanceLane();
    expect(requestMock.mock.calls[4][0].request.method).toBe(ChiaMethod.GetWalletBalance);

    balance.resolve({ confirmedWalletBalance: 11n });
    await expect(p1).resolves.toMatchObject({ height: 7n });
    await expect(p2).resolves.toMatchObject({ confirmedWalletBalance: 11n });
    await expect(p3).resolves.toMatchObject({ offer: 'offer1' });
    await expect(p4).resolves.toMatchObject({ coins: [] });
    await expect(p5).resolves.toMatchObject({ success: true });
  });

  it('guards repeated height polling while queued and schedules one next timer after response', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const heights: bigint[] = [];
    requestMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    walletConnectScheduler.startHeightInterest(1000, {
      onHeight: (height) => heights.push(height),
    });
    walletConnectScheduler.startHeightInterest(1000, {
      onHeight: (height) => heights.push(height),
    });

    await advanceLane();
    expect(requestMock).toHaveBeenCalledTimes(1);

    first.resolve({ height: 8n, success: true });
    await flushPromises();
    expect(heights).toEqual([8n]);

    await jest.advanceTimersByTimeAsync(999);
    expect(requestMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await advanceLane();
    expect(requestMock).toHaveBeenCalledTimes(2);

    second.resolve({ height: 9n, success: true });
    await flushPromises();
    expect(heights).toEqual([8n, 9n]);
  });

  it('guards repeated balance polling while queued', async () => {
    const first = deferred<unknown>();
    const balances: bigint[] = [];
    requestMock.mockReturnValueOnce(first.promise);

    walletConnectScheduler.startBalanceInterest(1000, {
      onBalance: (balance) => balances.push(balance),
    });
    walletConnectScheduler.startBalanceInterest(1000, {
      onBalance: (balance) => balances.push(balance),
    });

    await advanceLane();
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][0].request.method).toBe(ChiaMethod.GetWalletBalance);

    first.resolve({ confirmedWalletBalance: 23n });
    await flushPromises();
    expect(balances).toEqual([23n]);
  });

  it('waits for an entire coin sweep before reporting and scheduling the next sweep', async () => {
    const register = deferred<unknown>();
    const coinA = deferred<unknown>();
    const coinB = deferred<unknown>();
    const reports: unknown[][] = [];
    requestMock
      .mockReturnValueOnce(register.promise)
      .mockReturnValueOnce(coinA.promise)
      .mockReturnValueOnce(coinB.promise);

    walletConnectScheduler.setRemoteWalletId(99n);
    walletConnectScheduler.setCoinInterest(
      [
        { coin_name: 'aa', coin_string: 'coin-a' },
        { coin_name: 'bb', coin_string: 'coin-b' },
      ],
      1000,
      {
        onRecords: (records) => reports.push(records),
      },
    );

    await advanceLane();
    expect(requestMock.mock.calls[0][0].request.method).toBe(ChiaMethod.RegisterRemoteCoins);
    register.resolve({ success: true });

    await advanceLane();
    expect(requestMock.mock.calls[1][0].request).toMatchObject({
      method: ChiaMethod.GetCoinRecordsByNames,
      params: expect.objectContaining({ names: ['aa'] }),
    });
    coinA.resolve({ coinRecords: [{ coin: { amount: 1n } }], success: true });
    await flushPromises();
    expect(reports).toEqual([]);

    await advanceLane();
    expect(requestMock.mock.calls[2][0].request).toMatchObject({
      method: ChiaMethod.GetCoinRecordsByNames,
      params: expect.objectContaining({ names: ['bb'] }),
    });
    coinB.resolve({ coinRecords: [{ coin: { amount: 2n } }], success: true });
    await flushPromises();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toHaveLength(2);

    await jest.advanceTimersByTimeAsync(999);
    expect(requestMock).toHaveBeenCalledTimes(3);
  });
});
