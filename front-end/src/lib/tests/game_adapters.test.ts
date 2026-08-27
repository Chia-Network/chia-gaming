import { calpokerProposalParameters } from '@games/calpoker/ui/handProposal';
import { krunkProposalParameters } from '@games/krunk/ui/handProposal';
import { spacepokerProposalParameters } from '@games/spacepoker/ui/unitSize';
import { protocolIdForCatalog, resetProtocolIds, setProtocolIds } from '../gameIdentities';
import {
  DEFAULT_CATALOG_GAME_TYPE,
  describeReceivedProposal,
  handProposalsEqual,
  isProposalParameterValue,
  packageFor,
  REGISTERED_GAMES,
} from '../gameRegistry';
import { PRODUCTION_PACKAGE_KEYS } from '../../generated/gamePresets';
import { proposalGroupFromProposalMade } from '../session/incomingProposal';
import type { HandProposal } from '../session/types';

const SPACE_PROPOSAL: HandProposal = {
  gameType: 'spacepoker',
  playerAContribution: 100n,
  playerBContribution: 100n,
  senderIsPlayerA: false,
  gameTimeout: 15n,
  parameters: 10n,
};

describe('game package proposal adapters', () => {
  beforeAll(() => {
    setProtocolIds([
      { key: 'calpoker', id: '11'.repeat(32) },
      { key: 'spacepoker', id: '22'.repeat(32) },
      { key: 'krunk', id: '33'.repeat(32) },
    ]);
  });
  afterAll(resetProtocolIds);

  it('derives display metadata from the generated keyed packages', () => {
    expect(REGISTERED_GAMES.map(({ gameType }) => gameType)).toEqual([...PRODUCTION_PACKAGE_KEYS]);
    expect(DEFAULT_CATALOG_GAME_TYPE).toBe(PRODUCTION_PACKAGE_KEYS[0]);
    expect(packageFor('spacepoker').displayName).toBe('Space Poker');
  });

  it('uses one exact package-owned codec per game', () => {
    expect(calpokerProposalParameters.encode({})).toBeNull();
    expect(calpokerProposalParameters.decode(null)).toEqual({});
    expect(calpokerProposalParameters.decode(false)).toBeNull();

    expect(spacepokerProposalParameters.encode({ betUnitMojos: 10n })).toBe(10n);
    expect(spacepokerProposalParameters.decode(10n)).toEqual({ betUnitMojos: 10n });
    expect(spacepokerProposalParameters.decode('10')).toBeNull();
    expect(spacepokerProposalParameters.decode(Uint8Array.of(49, 48))).toBeNull();
    expect(spacepokerProposalParameters.decode(true)).toBeNull();

    expect(krunkProposalParameters.encode({})).toBeNull();
    expect(krunkProposalParameters.decode(null)).toEqual({});
    expect(krunkProposalParameters.decode(0n)).toBeNull();
  });

  it('recognizes every distinct opaque Bencodex parameter value', () => {
    const values = [
      null,
      false,
      true,
      -1n,
      'é🙂',
      Uint8Array.of(0, 255),
      [null, true, 2n, '文字', Uint8Array.of(1)],
    ];
    expect(values.every(isProposalParameterValue)).toBe(true);
    expect(isProposalParameterValue({ bytes: [1] })).toBe(false);
    expect(isProposalParameterValue(1)).toBe(false);
  });

  it('compares exact generic proposal terms, including opaque bytes', () => {
    const bytesProposal = {
      ...SPACE_PROPOSAL,
      parameters: [Uint8Array.of(0, 255), 'é'] as const,
    };
    expect(handProposalsEqual(bytesProposal, { ...bytesProposal })).toBe(true);
    expect(
      handProposalsEqual(bytesProposal, {
        ...bytesProposal,
        parameters: [Uint8Array.of(0, 254), 'é'],
      }),
    ).toBe(false);
    expect(handProposalsEqual(SPACE_PROPOSAL, { ...SPACE_PROPOSAL, senderIsPlayerA: true })).toBe(
      false,
    );
  });

  it('projects display text through the package codec', () => {
    expect(describeReceivedProposal(SPACE_PROPOSAL)).toContain('bet unit 10 mojos');
    expect(() => describeReceivedProposal({ ...SPACE_PROPOSAL, parameters: '10' })).toThrow(
      'parameters are invalid',
    );
  });

  it('parses ProposalMade as a generic A/B-oriented opaque proposal', () => {
    const parameters = null;
    const group = proposalGroupFromProposalMade({
      id: 4n,
      group_ids: [4n],
      player_a_contribution: '30',
      player_b_contribution: '40',
      sender_is_player_a: false,
      timeout: '21',
      game_type: protocolIdForCatalog('calpoker'),
      parameters,
    });
    expect(group?.handProposal).toEqual({
      gameType: 'calpoker',
      playerAContribution: 30n,
      playerBContribution: 40n,
      senderIsPlayerA: false,
      gameTimeout: 21n,
      parameters,
    });
    expect(group?.handProposal.parameters).toBe(parameters);
  });

  it('rejects malformed generic and package-specific peer parameters', () => {
    const base = {
      id: 4n,
      group_ids: [4n],
      player_a_contribution: '30',
      player_b_contribution: '30',
      sender_is_player_a: true,
      timeout: '21',
      game_type: protocolIdForCatalog('spacepoker'),
      parameters: 10n,
    };
    expect(
      proposalGroupFromProposalMade({ ...base, player_a_contribution: 'not-an-amount' }),
    ).toBeNull();
    expect(proposalGroupFromProposalMade({ ...base, sender_is_player_a: 1 })).toBeNull();
    expect(proposalGroupFromProposalMade({ ...base, parameters: '10' })).toBeNull();
    expect(proposalGroupFromProposalMade({ ...base, parameters: Uint8Array.of(10) })).toBeNull();
  });
});
