import type { SessionPhase } from '../../types/ChiaGaming';
import { canSwitchWallet, type WalletSwitchState } from '../../util/walletSwitch';

const idle: WalletSwitchState = {
  sessionPhase: 'none',
  durableSession: null,
  hasPairingToken: false,
  acceptInFlight: false,
  busy: false,
};

describe('canSwitchWallet', () => {
  it('allows a switch with no session and nothing to resume', () => {
    expect(canSwitchWallet(idle)).toBe(true);
  });

  it.each<SessionPhase>(['off-chain', 'on-chain', 'resolved'])(
    'refuses while a %s session is live, since its funds belong to the current wallet',
    (sessionPhase) => {
      expect(canSwitchWallet({ ...idle, sessionPhase })).toBe(false);
    },
  );

  it.each(['live', 'pre-handshake'] as const)(
    'refuses while a saved %s session awaits resume, even before the live phase returns',
    (phase) => {
      expect(canSwitchWallet({ ...idle, durableSession: { phase } })).toBe(false);
    },
  );

  it('refuses while Accept is starting a session that is not saved yet', () => {
    // The session already holds this wallet's scope, though phase and save still look idle.
    expect(canSwitchWallet({ ...idle, acceptInFlight: true })).toBe(false);
  });

  it('allows a switch when the saved session is terminal', () => {
    expect(canSwitchWallet({ ...idle, durableSession: { phase: 'terminal' } })).toBe(true);
  });

  it('refuses during a pending pairing or while a connect or switch runs', () => {
    expect(canSwitchWallet({ ...idle, hasPairingToken: true })).toBe(false);
    expect(canSwitchWallet({ ...idle, busy: true })).toBe(false);
  });
});
