import {
  composeDraftCanSubmit,
  composeDraftTerms,
  composeDraftValue,
  createComposeDraftState,
  selectComposeGame,
  updateSelectedComposeDraft,
} from '../session/composeDraft';
import { resetProtocolIds, setProtocolIds } from '../gameIdentities';
import { TEST_PROTOCOL_IDS } from './protocolIdentities';

const CALPOKER_TERMS = {
  gameType: 'calpoker' as const,
  myContribution: 25n,
  theirContribution: 25n,
  gameTimeout: 15n,
};

describe('compose draft state', () => {
  it('keeps editable invalid drafts separate from submission validity', () => {
    let state = createComposeDraftState(0n, {
      ...CALPOKER_TERMS,
      myContribution: 0n,
      theirContribution: 0n,
    });
    expect(composeDraftTerms(state)).toBeNull();

    state = updateSelectedComposeDraft(state, { amount: 25n });
    expect(composeDraftTerms(state)).toEqual(CALPOKER_TERMS);

    state = selectComposeGame(state, 'krunk');
    state = updateSelectedComposeDraft(state, { amount: 250n });
    expect(composeDraftCanSubmit(state, null)).toBe(false);
    state = updateSelectedComposeDraft(state, { amount: 300n });
    expect(composeDraftCanSubmit(state, 299n)).toBe(false);
    expect(composeDraftCanSubmit(state, 300n)).toBe(true);

    state = selectComposeGame(state, 'spacepoker');
    state = updateSelectedComposeDraft(state, { unitSize: 7n, stackSize: 13n });
    expect(composeDraftTerms(state)).toEqual({
      gameType: 'spacepoker',
      myContribution: 91n,
      theirContribution: 91n,
      gameTimeout: 15n,
      unitSizeMojos: 7n,
    });
    state = updateSelectedComposeDraft(state, {
      stackSize: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    });
    expect(composeDraftTerms(state)).toBeNull();
  });

  it('restores every exact draft after switching away and back', () => {
    let state = createComposeDraftState(25n, CALPOKER_TERMS);
    state = updateSelectedComposeDraft(state, { amount: 37n });
    state = selectComposeGame(state, 'krunk');
    state = updateSelectedComposeDraft(state, { amount: 900n });
    state = selectComposeGame(state, 'spacepoker');
    state = updateSelectedComposeDraft(state, { unitSize: 11n, stackSize: 17n });

    state = selectComposeGame(state, 'krunk');
    expect(state.drafts.krunk.amount).toBe(900n);
    state = selectComposeGame(state, 'spacepoker');
    expect(state.drafts.spacepoker).toEqual({ unitSize: 11n, stackSize: 17n });
    state = selectComposeGame(state, 'calpoker');
    expect(state.drafts.calpoker.amount).toBe(37n);
  });

  it('looks up drafts by catalog gameType after protocol identities are set', () => {
    const state = createComposeDraftState(25n, CALPOKER_TERMS);
    setProtocolIds(TEST_PROTOCOL_IDS);
    try {
      expect(composeDraftValue(state, 'calpoker')).toEqual({ amount: 25n });
      expect(composeDraftTerms(state)?.myContribution).toBe(25n);
    } finally {
      resetProtocolIds();
    }
  });
});
