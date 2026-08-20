import type { GamePackage } from '../../host';
import { krunkRegistration, type KrunkFactoryParameters } from './adapter';
import { KrunkComposeEditor } from './ComposeEditor';
import { krunkMountRegistration } from './LiveMount';
import type { KrunkGameState, KrunkHandState } from './stateCodec';

export const krunkPackage: GamePackage<
  KrunkHandState,
  { amount: bigint },
  KrunkGameState,
  KrunkFactoryParameters
> = Object.assign(krunkRegistration, {
  ComposeEditor: KrunkComposeEditor,
  ...krunkMountRegistration,
});

export default krunkPackage;
