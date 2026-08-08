import { Program } from 'clvm-lib';
import type { PersistedGameState } from '../../lib/session/gameStateCodec';
import type { HandTermsModel } from '../../lib/session/types';
import { spacepokerStateCodec } from './stateCodec';

function positive(value: bigint): bigint | null {
  return value > 0n ? value : null;
}

export function decodeSpacepokerUnitSize(value: unknown): bigint | null {
  if (!(value instanceof Uint8Array)) return null;
  try {
    return positive(Program.deserialize(value).toBigInt());
  } catch {
    return null;
  }
}

/**
 * The sole resolver for Space Poker's protocol unit. Every source is validated,
 * and multiple available sources must agree.
 */
export function resolveSpacepokerUnitSize(input: {
  terms?: HandTermsModel | null;
  persistedState?: PersistedGameState | null;
  encodedParameterState?: unknown;
}): bigint | null {
  const candidates: bigint[] = [];
  if (input.terms?.gameType === 'spacepoker') {
    const value = positive(input.terms.unitSizeMojos);
    if (!value) return null;
    candidates.push(value);
  }
  if (input.persistedState) {
    const state = spacepokerStateCodec.decode(input.persistedState);
    if (input.persistedState.gameType === 'spacepoker' && !state) return null;
    if (state) {
      const value = positive(state.unitSizeMojos);
      if (!value) return null;
      candidates.push(value);
    }
  }
  if (input.encodedParameterState !== undefined) {
    const value = decodeSpacepokerUnitSize(input.encodedParameterState);
    if (!value) return null;
    candidates.push(value);
  }
  if (candidates.length === 0) return null;
  return candidates.every((value) => value === candidates[0]) ? candidates[0] : null;
}
