import { decodePersistedGameTerms, isRegisteredGameType } from '../gameRegistry';
import type { ComposeDraftState } from './composeDraft';
import type { HandTermsModel, ProposalGroupModel } from './types';
import {
  parseDecimalString,
  requireBoolean,
  requireRecord,
  requireString,
  requireUniqueIds,
} from './persistencePrimitives';

export function parseComposeDraftState(value: unknown): ComposeDraftState {
  const saved = requireRecord(value, 'betweenHandCompose');
  const selectedGame = saved.selected_game;
  if (!isRegisteredGameType(selectedGame)) {
    throw new Error('Garbled save: invalid betweenHandCompose.selected_game');
  }
  const calpoker = requireRecord(saved.calpoker, 'betweenHandCompose.calpoker');
  const krunk = requireRecord(saved.krunk, 'betweenHandCompose.krunk');
  const spacepoker = requireRecord(saved.spacepoker, 'betweenHandCompose.spacepoker');
  return {
    selectedGame,
    gameTimeout: parseDecimalString(saved.game_timeout, 'betweenHandCompose.game_timeout', 0n),
    proposalSent: requireBoolean(saved.proposal_sent, 'betweenHandCompose.proposal_sent'),
    calpoker: {
      amount: parseDecimalString(calpoker.amount, 'betweenHandCompose.calpoker.amount', 0n),
    },
    krunk: {
      amount: parseDecimalString(krunk.amount, 'betweenHandCompose.krunk.amount', 0n),
    },
    spacepoker: {
      unitSize: parseDecimalString(
        spacepoker.unit_size,
        'betweenHandCompose.spacepoker.unit_size',
        0n,
      ),
      stackSize: parseDecimalString(
        spacepoker.stack_size,
        'betweenHandCompose.spacepoker.stack_size',
        0n,
      ),
    },
  };
}

export function parseTermsSnapshot(value: unknown, label: string): HandTermsModel {
  const saved = requireRecord(value, label);
  const gameType = saved.game_type;
  if (!isRegisteredGameType(gameType)) {
    throw new Error(`Garbled save: unknown ${label}.game_type ${String(gameType)}`);
  }
  const myContribution = parseDecimalString(saved.my_contribution, `${label}.my_contribution`, 0n);
  const terms = decodePersistedGameTerms(
    gameType,
    {
      myContribution,
      theirContribution: parseDecimalString(
        saved.their_contribution,
        `${label}.their_contribution`,
        0n,
      ),
      gameTimeout: parseDecimalString(saved.game_timeout, `${label}.game_timeout`, 1n),
    },
    {
      spacepoker_unit_size:
        saved.spacepoker_unit_size === undefined
          ? undefined
          : requireString(saved.spacepoker_unit_size, `${label}.spacepoker_unit_size`),
    },
  );
  if (!terms) throw new Error(`Garbled save: invalid ${label} ${gameType} terms`);
  return terms;
}

export function parseOptionalTermsSnapshot(saved: unknown, label: string): HandTermsModel | null {
  return saved === null ? null : parseTermsSnapshot(saved, label);
}

export function parseProposalGroups(value: unknown, label: string): ProposalGroupModel[] {
  if (!Array.isArray(value)) throw new Error(`Garbled save: invalid ${label}`);
  const seen = new Set<string>();
  let localOutgoing = 0;
  const groups = value.map((entry, index): ProposalGroupModel => {
    const groupLabel = `${label}[${index}]`;
    const saved = requireRecord(entry, groupLabel);
    const primaryId = requireString(saved.primary_id, `${groupLabel}.primary_id`);
    const memberIds = requireUniqueIds(saved.member_ids, `${groupLabel}.member_ids`, true);
    if (primaryId !== memberIds[0]) {
      throw new Error(`Garbled save: ${groupLabel}.primary_id is not the first member`);
    }
    for (const id of memberIds) {
      if (seen.has(id)) throw new Error(`Garbled save: proposal member ${id} appears twice`);
      seen.add(id);
    }
    const origin = saved.origin;
    if (origin !== 'local' && origin !== 'peer') {
      throw new Error(`Garbled save: invalid ${groupLabel}.origin`);
    }
    const disposition = saved.disposition;
    if (
      disposition !== 'outgoing' &&
      disposition !== 'incoming-cached' &&
      disposition !== 'incoming-review' &&
      disposition !== 'accepted'
    ) {
      throw new Error(`Garbled save: invalid ${groupLabel}.disposition`);
    }
    if (disposition === 'outgoing' && origin !== 'local') {
      throw new Error(`Garbled save: outgoing ${groupLabel} is not local`);
    }
    if (
      (disposition === 'incoming-cached' || disposition === 'incoming-review') &&
      origin !== 'peer'
    ) {
      throw new Error(`Garbled save: incoming ${groupLabel} is not peer-originated`);
    }
    if (origin === 'local' && disposition === 'outgoing') localOutgoing += 1;
    const terms = parseTermsSnapshot(saved.terms, `${groupLabel}.terms`);
    const expectedMembers = terms.gameType === 'krunk' ? 2 : 1;
    if (memberIds.length !== expectedMembers) {
      throw new Error(
        `Garbled save: ${groupLabel} has ${memberIds.length} members for ${terms.gameType}`,
      );
    }
    return {
      primaryId,
      memberIds,
      terms,
      origin,
      disposition,
    };
  });
  if (localOutgoing > 1) {
    throw new Error('Garbled save: multiple local outgoing proposal groups');
  }
  return groups;
}
