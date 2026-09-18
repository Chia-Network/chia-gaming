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
import { pendingProposalFromProposalMade } from '../session/incomingProposal';
import { MAX_GAME_TIMEOUT_BLOCKS, MIN_GAME_TIMEOUT_BLOCKS } from '../session/gameTimeout';
import type { HandProposal } from '../session/types';

const SPACE_PROPOSAL: HandProposal = {
  gameType: 'spacepoker',
  senderIsPlayerA: false,
  gameTimeout: 15n,
  parameters: [10n, 10n],
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
    expect(calpokerProposalParameters.encode(25n)).toBe(25n);
    expect(calpokerProposalParameters.decode(25n)).toBe(25n);
    expect(calpokerProposalParameters.decode(false)).toBeNull();

    expect(spacepokerProposalParameters.encode({ stackSize: 0n, betUnitMojos: 10n })).toEqual([
      0n,
      10n,
    ]);
    expect(spacepokerProposalParameters.decode([0n, 10n])).toEqual({
      stackSize: 0n,
      betUnitMojos: 10n,
    });
    expect(spacepokerProposalParameters.decode('10')).toBeNull();
    expect(spacepokerProposalParameters.decode(Uint8Array.of(49, 48))).toBeNull();
    expect(spacepokerProposalParameters.decode(true)).toBeNull();

    expect(krunkProposalParameters.encode(100n)).toBe(100n);
    expect(krunkProposalParameters.decode(100n)).toBe(100n);
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
    expect(handProposalsEqual(bytesProposal, 'peer', { ...bytesProposal }, 'peer')).toBe(true);
    expect(
      handProposalsEqual(
        bytesProposal,
        'peer',
        {
          ...bytesProposal,
          parameters: [Uint8Array.of(0, 254), 'é'],
        },
        'peer',
      ),
    ).toBe(false);
    expect(
      handProposalsEqual(
        SPACE_PROPOSAL,
        'peer',
        { ...SPACE_PROPOSAL, senderIsPlayerA: true },
        'local',
      ),
    ).toBe(true);
    expect(
      handProposalsEqual(
        SPACE_PROPOSAL,
        'peer',
        { ...SPACE_PROPOSAL, senderIsPlayerA: true },
        'peer',
      ),
    ).toBe(false);
  });

  it('projects display text through the package codec', () => {
    expect(describeReceivedProposal(SPACE_PROPOSAL)).toContain('minimum raise 10 mojos');
    expect(() => describeReceivedProposal({ ...SPACE_PROPOSAL, parameters: '10' })).toThrow(
      'parameters are invalid',
    );
  });

  it('parses ProposalMade as a generic A/B-oriented opaque proposal', () => {
    const parameters = 30n;
    const proposal = pendingProposalFromProposalMade({
      id: 4n,
      sender_is_player_a: false,
      timeout: '21',
      game_type: protocolIdForCatalog('calpoker'),
      parameters,
    });
    expect(proposal?.id).toBe('4');
    expect(proposal?.handProposal).toEqual({
      gameType: 'calpoker',
      senderIsPlayerA: false,
      gameTimeout: 21n,
      parameters,
    });
    expect(proposal?.handProposal.parameters).toBe(parameters);
  });

  it('rejects malformed envelopes and retains package-invalid parameters for cancellation', () => {
    const base = {
      id: 4n,
      sender_is_player_a: true,
      timeout: '21',
      game_type: protocolIdForCatalog('spacepoker'),
      parameters: [3n, 10n],
    };
    expect(pendingProposalFromProposalMade({ ...base, id: null as never })).toBeNull();
    expect(pendingProposalFromProposalMade({ ...base, sender_is_player_a: 1 })).toBeNull();
    for (const parameters of ['10', Uint8Array.of(10)]) {
      expect(pendingProposalFromProposalMade({ ...base, parameters })).toMatchObject({
        id: '4',
        lifecycle: 'peer-cancel-queued',
      });
    }
  });

  it('accepts only bounded peer game timeouts', () => {
    const base = {
      id: 4n,
      sender_is_player_a: true,
      game_type: protocolIdForCatalog('calpoker'),
      parameters: 30n,
    };
    for (const timeout of [MIN_GAME_TIMEOUT_BLOCKS, MAX_GAME_TIMEOUT_BLOCKS]) {
      expect(
        pendingProposalFromProposalMade({ ...base, timeout: timeout.toString() }),
      ).not.toBeNull();
    }
    for (const timeout of [
      MIN_GAME_TIMEOUT_BLOCKS - 1n,
      MAX_GAME_TIMEOUT_BLOCKS + 1n,
      4_294_967_296n,
    ]) {
      expect(pendingProposalFromProposalMade({ ...base, timeout: timeout.toString() })).toBeNull();
    }
  });
});
