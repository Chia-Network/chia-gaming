import { Program } from 'clvm-lib';
import {
  readClvmAtom,
  readClvmFlag,
  readClvmList,
  readClvmProgram,
  type FactoryParameterCodec,
  type PersistedGameState,
  type HandTermsModel,
} from '../../host';
import { spacepokerStateCodec } from './stateCodec';
function positive(value: bigint | undefined): bigint | null {
  return value !== undefined && value > 0n ? value : null;
}

export type SpacepokerTerms = HandTermsModel & { unitSizeMojos: bigint };

export function spacepokerTermsOf(terms: HandTermsModel): SpacepokerTerms | null {
  if (terms.gameType !== 'spacepoker') return null;
  const unitSizeMojos = (terms as SpacepokerTerms).unitSizeMojos;
  return positive(unitSizeMojos) ? (terms as SpacepokerTerms) : null;
}

export type SpacepokerFactoryParameters = {
  perPlayerStake: bigint;
  betUnit: bigint;
  senderGoesFirst: boolean;
};

export const spacepokerFactoryParameters: FactoryParameterCodec<SpacepokerFactoryParameters> = {
  decode(value) {
    const program = readClvmProgram(value);
    if (!program) return null;
    const items = readClvmList(program, 3);
    if (!items) return null;
    const perPlayerStake = readClvmAtom(items[0]);
    const betUnit = readClvmAtom(items[1]);
    const senderGoesFirst = readClvmFlag(items[2]);
    if (
      perPlayerStake === null ||
      betUnit === null ||
      senderGoesFirst === null ||
      perPlayerStake <= 0n ||
      betUnit <= 0n ||
      perPlayerStake % betUnit !== 0n
    ) {
      return null;
    }
    return { perPlayerStake, betUnit, senderGoesFirst };
  },
  encode(params) {
    return Program.fromList([
      Program.fromBigInt(params.perPlayerStake),
      Program.fromBigInt(params.betUnit),
      Program.fromBigInt(params.senderGoesFirst ? 1n : 0n),
    ]);
  },
};

export function decodeSpacepokerUnitSize(value: unknown): bigint | null {
  return spacepokerFactoryParameters.decode(value)?.betUnit ?? null;
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
  if (input.terms && input.terms.gameType === 'spacepoker') {
    const terms = spacepokerTermsOf(input.terms);
    if (!terms) return null;
    candidates.push(terms.unitSizeMojos);
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
