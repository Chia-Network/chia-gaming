import { needsConnectionSetupPrompt, needsWalletPairing } from '../../util/connectionSetup';
import type { ConnectionField } from '../../types/ChiaGaming';

const stringField: ConnectionField = { type: 'string', label: 'Client ID', default: '' };
const bigintField: ConnectionField = { type: 'bigint', label: 'Balance', default: 0n };

describe('connectionSetup flags', () => {
  it('treats QR pairing as wait-for-wallet, not auto-finalize', () => {
    const setup = { skipQr: undefined, fields: undefined };
    expect(needsWalletPairing(setup)).toBe(true);
    expect(needsConnectionSetupPrompt(setup)).toBe(false);
  });

  it('treats restored WC/Cloud sessions as silent-finalize', () => {
    const setup = { skipQr: true, fields: undefined };
    expect(needsWalletPairing(setup)).toBe(false);
    expect(needsConnectionSetupPrompt(setup)).toBe(false);
  });

  it('treats simulator fields as skippable on silent reconnect', () => {
    const setup = { skipQr: undefined, fields: { balance: bigintField } };
    expect(needsWalletPairing(setup)).toBe(false);
    expect(needsConnectionSetupPrompt(setup)).toBe(false);
  });

  it('treats skipQr+fields as a required prompt (Cloud Wallet, no stored auth)', () => {
    const setup = { skipQr: true, fields: { clientId: stringField } };
    expect(needsWalletPairing(setup)).toBe(false);
    expect(needsConnectionSetupPrompt(setup)).toBe(true);
  });
});
