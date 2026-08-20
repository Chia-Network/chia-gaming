import type { GamePackage } from '../../host';
import { spacepokerRegistration } from './adapter';
import { SpacepokerComposeEditor } from './ComposeEditor';
import { spacepokerMountRegistration } from './LiveMount';
import type { SpacepokerHandState } from './stateCodec';
import type { SpacepokerFactoryParameters } from './unitSize';

export const spacepokerPackage: GamePackage<
  SpacepokerHandState,
  { unitSize: bigint; stackSize: bigint },
  SpacepokerHandState,
  SpacepokerFactoryParameters
> = Object.assign(spacepokerRegistration, {
  ComposeEditor: SpacepokerComposeEditor,
  ...spacepokerMountRegistration,
});

export default spacepokerPackage;
