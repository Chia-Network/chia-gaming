import { calpokerRegistration, type CalpokerFactoryParameters } from './adapter';
import { CalpokerComposeEditor } from './ComposeEditor';
import { calpokerMountRegistration } from './LiveMount';
import type { GamePackage } from '../../host';
import type { CalpokerHandState } from './stateCodec';

export const calpokerPackage: GamePackage<
  CalpokerHandState,
  { amount: bigint },
  CalpokerHandState,
  CalpokerFactoryParameters
> = Object.assign(calpokerRegistration, {
  ComposeEditor: CalpokerComposeEditor,
  ...calpokerMountRegistration,
});

export default calpokerPackage;
