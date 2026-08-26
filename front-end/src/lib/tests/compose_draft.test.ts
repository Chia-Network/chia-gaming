import {
  applyHandProposalToComposeDraft,
  createComposeDraftState,
  emptyComposeDraftState,
  selectComposeGame,
} from '../session/composeDraft';
import type { HandProposal } from '../session/types';

const TERMS: HandProposal = {
  gameType: 'calpoker',
  playerAContribution: 25n,
  playerBContribution: 25n,
  senderIsPlayerA: false,
  gameTimeout: 15n,
  parameters: null,
};

describe('compose host state', () => {
  it('owns only selector, timeout, and submission state', () => {
    expect(createComposeDraftState(TERMS)).toEqual({
      selectedGame: 'calpoker',
      gameTimeout: 15n,
      proposalSent: false,
    });
    expect(emptyComposeDraftState()).toEqual({
      selectedGame: 'calpoker',
      gameTimeout: 15n,
      proposalSent: false,
    });
  });

  it('does not retain per-game controls while switching packages', () => {
    const selected = selectComposeGame(createComposeDraftState(TERMS), 'spacepoker');
    expect(selected).toEqual({
      selectedGame: 'spacepoker',
      gameTimeout: 15n,
      proposalSent: false,
    });
    expect(Object.hasOwn(selected, 'drafts')).toBe(false);
  });

  it('repopulates only generic host fields from completed terms', () => {
    const next = applyHandProposalToComposeDraft(emptyComposeDraftState(), {
      ...TERMS,
      gameType: 'krunk',
      gameTimeout: 30n,
    });
    expect(next).toEqual({
      selectedGame: 'krunk',
      gameTimeout: 30n,
      proposalSent: false,
    });
  });
});
