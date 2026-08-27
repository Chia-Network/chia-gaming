// Generated from games/registry.json. Do not edit.
export const PRODUCTION_PACKAGE_KEYS = ['calpoker', 'spacepoker', 'krunk'] as const;
export type CatalogGameType = (typeof PRODUCTION_PACKAGE_KEYS)[number];
export const CORE_PRESET_FILES = [
  'clsp/unroll/unroll_puzzle_state_channel_unrolling.hex',
  'clsp/referee/onchain/referee.hex',
] as const;
export const GAME_PRESET_FILES = [
  'games/calpoker/clsp/factory_calpoker_factory.hex',
  'games/spacepoker/clsp/factory_spacepoker_factory.hex',
  'games/krunk/clsp/factory_krunk_factory.hex',
  'games/krunk/clsp/krunk_signed_dict_tree.dat',
] as const;
export const PRESET_FILES = [...CORE_PRESET_FILES, ...GAME_PRESET_FILES];
