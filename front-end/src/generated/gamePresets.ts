// Generated from games/registry.json. Do not edit.
export const PRODUCTION_PACKAGE_KEYS = ['calpoker', 'spacepoker', 'krunk'] as const;
export type CatalogGameType = (typeof PRODUCTION_PACKAGE_KEYS)[number];
export const CORE_PRESET_FILES = [
  'clsp/unroll/unroll_puzzle_state_channel_unrolling.clvm.bin',
  'clsp/referee/onchain/referee.clvm.bin',
] as const;
export const GAME_PRESET_FILES = [
  'games/calpoker/clsp/factory_prepared.clvm.bin',
  'games/spacepoker/clsp/factory_prepared.clvm.bin',
  'games/krunk/clsp/factory_prepared.clvm.bin',
] as const;
export const PRESET_FILES = [...CORE_PRESET_FILES, ...GAME_PRESET_FILES];
