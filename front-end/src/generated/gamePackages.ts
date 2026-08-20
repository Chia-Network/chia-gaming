// Generated from games/registry.json. Do not edit.
import pkg0 from '../../../games/calpoker/ui/package';
import pkg1 from '../../../games/spacepoker/ui/package';
import pkg2 from '../../../games/krunk/ui/package';

export const PRODUCTION_PACKAGE_KEYS = ['calpoker', 'spacepoker', 'krunk'] as const;
export type CatalogGameType = (typeof PRODUCTION_PACKAGE_KEYS)[number];
export const GENERATED_GAME_PACKAGES = [pkg0, pkg1, pkg2];
export { PRESET_FILES, GAME_PRESET_FILES, CORE_PRESET_FILES } from './gamePresets';
