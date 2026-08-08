import {
  composeDraftCanSubmit,
  composeDraftTerms,
  createComposeDraftState,
  selectComposeGame,
  setComposeDraftAmount,
  setSpacepokerComposeDraft,
} from '../session/composeDraft';

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

    state = setComposeDraftAmount(state, 'calpoker', 25n);
    expect(composeDraftTerms(state)).toEqual(CALPOKER_TERMS);

    state = selectComposeGame(setComposeDraftAmount(state, 'krunk', 250n), 'krunk');
    expect(composeDraftCanSubmit(state, null)).toBe(false);
    state = setComposeDraftAmount(state, 'krunk', 300n);
    expect(composeDraftCanSubmit(state, 299n)).toBe(false);
    expect(composeDraftCanSubmit(state, 300n)).toBe(true);

    state = selectComposeGame(state, 'spacepoker');
    state = setSpacepokerComposeDraft(state, { unitSize: 7n, stackSize: 13n });
    expect(composeDraftTerms(state)).toEqual({
      gameType: 'spacepoker',
      myContribution: 91n,
      theirContribution: 91n,
      gameTimeout: 15n,
      unitSizeMojos: 7n,
    });
    state = setSpacepokerComposeDraft(state, {
      stackSize: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    });
    expect(composeDraftTerms(state)).toBeNull();
  });

  it('restores every exact draft after switching away and back', () => {
    let state = createComposeDraftState(25n, CALPOKER_TERMS);
    state = setComposeDraftAmount(state, 'calpoker', 37n);
    state = setComposeDraftAmount(state, 'krunk', 900n);
    state = setSpacepokerComposeDraft(state, { unitSize: 11n, stackSize: 17n });

    state = selectComposeGame(state, 'krunk');
    expect(state.krunk.amount).toBe(900n);
    state = selectComposeGame(state, 'spacepoker');
    expect(state.spacepoker).toEqual({ unitSize: 11n, stackSize: 17n });
    state = selectComposeGame(state, 'calpoker');
    expect(state.calpoker.amount).toBe(37n);
  });
});
