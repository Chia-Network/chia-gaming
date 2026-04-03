import type BigNumber from 'bignumber.js';

import WalletConnectCommandParamName from './WalletConnectCommandParamName';

type WalletConnectCommandParam = {
  name: WalletConnectCommandParamName;
  isOptional?: boolean;
  label?: string;
  description?: string;
  type?: 'string' | 'number' | 'boolean' | 'BigNumber' | 'object';
  defaultValue?: string | number | boolean | BigNumber | Record<any, any>;
  hide?: boolean;
};

export default WalletConnectCommandParam;
