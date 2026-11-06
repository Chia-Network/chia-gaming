import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import CloudWalletApprovalNotice from '../../components/CloudWalletApprovalNotice';
import { cloudBlockchainInfo } from '../wallet/CloudBlockchainInterface';

jest.mock('../wallet/CloudBlockchainInterface', () => ({
  cloudBlockchainInfo: {
    getBlockedApprovals: jest.fn(),
    onBlockedApprovalsChange: jest.fn(),
    openBlockedApproval: jest.fn(),
  },
}));

const iface = cloudBlockchainInfo as unknown as {
  getBlockedApprovals: jest.Mock;
  onBlockedApprovalsChange: jest.Mock;
  openBlockedApproval: jest.Mock;
};

const blockedFee = {
  signatureRequestId: 'SR_1',
  source: 'fee',
  reason: 'blocked',
  attach: () => {},
};

describe('CloudWalletApprovalNotice', () => {
  let notify: () => void;
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    jest.resetAllMocks();
    iface.onBlockedApprovalsChange.mockImplementation((listener: () => void) => {
      notify = listener;
      return () => {};
    });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => renderer.unmount());
  });

  function render(blocked: unknown[]) {
    iface.getBlockedApprovals.mockReturnValue(blocked);
    act(() => {
      renderer = create(<CloudWalletApprovalNotice />);
    });
  }

  const text = () => JSON.stringify(renderer.toJSON());
  const button = () => renderer.root.findByProps({ children: 'Open approval' }, { deep: true });

  it('renders nothing without a blocked approval', () => {
    render([]);
    expect(renderer.toJSON()).toBeNull();
  });

  it('asks the user to allow popups, and says so again when a click is still blocked', () => {
    render([blockedFee]);
    expect(text()).toMatch(/blocked the Cloud Wallet approval window for the fee/);

    iface.openBlockedApproval.mockReturnValue(false);
    act(() => button().props.onClick());
    expect(iface.openBlockedApproval).toHaveBeenCalledTimes(1);
    expect(text()).toMatch(/still blocked/);
  });

  it('tells the user a closed window can be opened again, without blaming the browser', () => {
    render([{ ...blockedFee, reason: 'closed' }]);
    expect(text()).toMatch(/approval window for the fee was closed/);
    expect(text()).not.toMatch(/blocked/);
  });

  it('disappears once the approval opens', () => {
    render([blockedFee]);
    iface.openBlockedApproval.mockImplementation(() => {
      iface.getBlockedApprovals.mockReturnValue([]);
      notify();
      return true;
    });
    act(() => button().props.onClick());
    expect(renderer.toJSON()).toBeNull();
  });
});
