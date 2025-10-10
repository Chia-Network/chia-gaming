import { Subject } from 'rxjs';

import { BlockchainReport } from '../types/ChiaGaming';

import { blockchainDataEmitter } from './BlockchainInfo';

export const parentFrameBlockchainInfo = new Subject<BlockchainReport>();
export const PARENT_FRAME_BLOCKCHAIN_ID = blockchainDataEmitter.addUpstream(parentFrameBlockchainInfo);
