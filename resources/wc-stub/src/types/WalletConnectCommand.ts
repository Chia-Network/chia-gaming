import type WalletConnectCommandParam from './WalletConnectCommandParam';

type ServiceNameValue = string;

type WalletConnectCommandBase = {
  command: string;
  label: string;
  description?: string;
  service: ServiceNameValue;
  allFingerprints?: boolean;
  waitForSync?: boolean;
  params?: WalletConnectCommandParam[];
  bypassConfirm?: boolean;
};

export type WalletConnectCommandNotification = Omit<WalletConnectCommandBase, 'service'> & {
  service: 'NOTIFICATION';
};

export type WalletConnectCommandExecute = Omit<WalletConnectCommandBase, 'service'> & {
  service: 'EXECUTE';
  execute: Object | ((params: Record<string, any>) => Object);
};

type WalletConnectCommand = WalletConnectCommandBase | WalletConnectCommandNotification | WalletConnectCommandExecute;

export default WalletConnectCommand;
