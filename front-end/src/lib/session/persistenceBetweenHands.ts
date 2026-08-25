import {
  decodePersistedHandProposal,
  isCatalogGameType,
  packageFor,
  REGISTERED_GAMES,
} from '../gameRegistry';
import type { ComposeDraftValue } from '@games/host';
import { composeDraftValue, type ComposeDraftState } from './composeDraft';
import type { SessionPresentationSave } from './saveEnvelope';
import type { HandProposal, ProposalGroupModel } from './types';
import {
  parseDecimalString,
  requireBoolean,
  requireRecord,
  requireString,
  requireUniqueIds,
} from './persistencePrimitives';

function encodeDraftValue(value: ComposeDraftValue): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [key, (field as bigint).toString()]),
  );
}

function parseDraftValue(
  raw: unknown,
  fallback: ComposeDraftValue,
  label: string,
): ComposeDraftValue {
  const saved = requireRecord(raw, label);
  const next = { ...fallback };
  for (const key of Object.keys(fallback)) {
    if (saved[key] !== undefined) {
      (next as Record<string, bigint>)[key] = parseDecimalString(saved[key], `${label}.${key}`, 0n);
    }
  }
  return next;
}

export function encodeComposeDraftState(
  compose: ComposeDraftState,
): SessionPresentationSave['betweenHandCompose'] {
  const drafts: Record<string, Record<string, string>> = {};
  for (const { gameType } of REGISTERED_GAMES) {
    drafts[gameType] = encodeDraftValue(composeDraftValue(compose, gameType));
  }
  return {
    selected_game: compose.selectedGame,
    game_timeout: compose.gameTimeout.toString(),
    proposal_sent: compose.proposalSent,
    drafts,
  };
}

export function parseComposeDraftState(value: unknown): ComposeDraftState {
  const saved = requireRecord(value, 'betweenHandCompose');
  const selectedGame = saved.selected_game;
  if (!isCatalogGameType(selectedGame)) {
    throw new Error('Garbled save: invalid betweenHandCompose.selected_game');
  }
  const savedDrafts = requireRecord(saved.drafts, 'betweenHandCompose.drafts');
  const drafts: Record<string, ComposeDraftValue> = {};
  for (const { gameType } of REGISTERED_GAMES) {
    const fallback = packageFor(gameType).draft.default(0n);
    drafts[gameType] = parseDraftValue(
      savedDrafts[gameType],
      fallback,
      `betweenHandCompose.drafts.${gameType}`,
    );
  }
  return {
    selectedGame: selectedGame,
    gameTimeout: parseDecimalString(saved.game_timeout, 'betweenHandCompose.game_timeout', 0n),
    proposalSent: requireBoolean(saved.proposal_sent, 'betweenHandCompose.proposal_sent'),
    drafts,
  };
}

export function parseHandProposalSnapshot(value: unknown, label: string): HandProposal {
  const saved = requireRecord(value, label);
  const gameType = saved.game_type;
  if (!isCatalogGameType(gameType)) {
    throw new Error(`Garbled save: unknown ${label}.game_type ${String(gameType)}`);
  }
  const myContribution = parseDecimalString(saved.my_contribution, `${label}.my_contribution`, 0n);
  const terms = decodePersistedHandProposal(
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
    saved.parameters,
  );
  if (!terms) throw new Error(`Garbled save: invalid ${label} ${gameType} terms`);
  return terms;
}

export function parseOptionalHandProposalSnapshot(
  saved: unknown,
  label: string,
): HandProposal | null {
  return saved === null ? null : parseHandProposalSnapshot(saved, label);
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
    const handProposal = parseHandProposalSnapshot(
      saved.hand_proposal,
      `${groupLabel}.hand_proposal`,
    );
    return {
      primaryId,
      memberIds,
      handProposal,
      origin,
      disposition,
    };
  });
  if (localOutgoing > 1) {
    throw new Error('Garbled save: multiple local outgoing proposal groups');
  }
  return groups;
}
