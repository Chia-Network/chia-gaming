describe('simulator settings', () => {
  const originalServiceUrl = process.env.CHIA_GAMING_SIM_URL;
  const originalWebSocketUrl = process.env.CHIA_GAMING_SIM_WS_URL;

  afterEach(() => {
    if (originalServiceUrl === undefined) delete process.env.CHIA_GAMING_SIM_URL;
    else process.env.CHIA_GAMING_SIM_URL = originalServiceUrl;
    if (originalWebSocketUrl === undefined) delete process.env.CHIA_GAMING_SIM_WS_URL;
    else process.env.CHIA_GAMING_SIM_WS_URL = originalWebSocketUrl;
    jest.resetModules();
  });

  it('does not fall back to the local-demo port under Jest', async () => {
    delete process.env.CHIA_GAMING_SIM_URL;
    delete process.env.CHIA_GAMING_SIM_WS_URL;
    jest.resetModules();

    const { BLOCKCHAIN_SERVICE_URL, BLOCKCHAIN_WS_URL } = await import('../../settings');

    expect(BLOCKCHAIN_SERVICE_URL).toBe('http://127.0.0.1:0');
    expect(BLOCKCHAIN_WS_URL).toBe('ws://127.0.0.1:0/ws');
  });
});
