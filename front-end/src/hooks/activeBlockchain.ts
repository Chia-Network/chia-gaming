import { InternalBlockchainInterface } from '../types/ChiaGaming';

let active: InternalBlockchainInterface | null = null;

export function setActiveBlockchain(impl: InternalBlockchainInterface) {
  active = impl;
}

export function getActiveBlockchain(): InternalBlockchainInterface {
  if (!active) throw new Error('No blockchain selected');
  return active;
}
