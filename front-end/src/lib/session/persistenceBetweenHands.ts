import { isCatalogGameType, isProposalParameterValue, validateHandProposal } from '../gameRegistry';
import type { ComposeDraftState } from './composeDraft';
import type { SessionPresentationSave } from './saveEnvelope';
import type { HandProposal, PendingProposalModel } from './types';
import {
  parseDecimalString,
  requireBoolean,
  requireRecord,
  requireString,
} from './persistencePrimitives';

export function encodeComposeDraftState(
  compose: ComposeDraftState,
): SessionPresentationSave['betweenHandCompose'] {
  return {
    selected_game: compose.selectedGame,
    game_timeout: compose.gameTimeout.toString(),
    proposal_sent: compose.proposalSent,
  };
}

export function parseComposeDraftState(value: unknown): ComposeDraftState {
  const saved = requireRecord(value, 'betweenHandCompose');
  const selectedGame = saved.selected_game;
  if (!isCatalogGameType(selectedGame)) {
    throw new Error('Garbled save: invalid betweenHandCompose.selected_game');
  }
  return {
    selectedGame: selectedGame,
    gameTimeout: parseDecimalString(saved.game_timeout, 'betweenHandCompose.game_timeout', 0n),
    proposalSent: requireBoolean(saved.proposal_sent, 'betweenHandCompose.proposal_sent'),
  };
}

export function parseHandProposalSnapshot(value: unknown, label: string): HandProposal {
  const saved = requireRecord(value, label);
  const gameType = saved.game_type;
  if (!isCatalogGameType(gameType)) {
    throw new Error(`Garbled save: unknown ${label}.game_type ${String(gameType)}`);
  }
  if (!isProposalParameterValue(saved.parameters)) {
    throw new Error(`Garbled save: invalid ${label}.parameters`);
  }
  const terms: HandProposal = {
    gameType,
    senderIsPlayerA: requireBoolean(saved.sender_is_player_a, `${label}.sender_is_player_a`),
    gameTimeout: parseDecimalString(saved.game_timeout, `${label}.game_timeout`, 1n),
    parameters: saved.parameters,
  };
  if (!validateHandProposal(terms)) {
    throw new Error(`Garbled save: invalid ${label} ${gameType} terms`);
  }
  return terms;
}

export function parseOptionalHandProposalSnapshot(
  saved: unknown,
  label: string,
): HandProposal | null {
  return saved === null ? null : parseHandProposalSnapshot(saved, label);
}

export function parsePendingProposals(value: unknown, label: string): PendingProposalModel[] {
  if (!Array.isArray(value)) throw new Error(`Garbled save: invalid ${label}`);
  const seen = new Set<string>();
  let localOutgoing = 0;
  const proposals = value.map((entry, index): PendingProposalModel => {
    const proposalLabel = `${label}[${index}]`;
    const saved = requireRecord(entry, proposalLabel);
    const id = requireString(saved.id, `${proposalLabel}.id`);
    if (seen.has(id)) throw new Error(`Garbled save: duplicate pending proposal ${id}`);
    seen.add(id);
    const origin = saved.origin;
    if (origin !== 'local' && origin !== 'peer') {
      throw new Error(`Garbled save: invalid ${proposalLabel}.origin`);
    }
    const status = saved.status;
    if (
      status !== 'outgoing' &&
      status !== 'incoming-cached' &&
      status !== 'incoming-review' &&
      status !== 'accepting' &&
      status !== 'advisory-cancelling'
    ) {
      throw new Error(`Garbled save: invalid ${proposalLabel}.status`);
    }
    if ((status === 'outgoing' || status === 'advisory-cancelling') && origin !== 'local') {
      throw new Error(`Garbled save: outgoing ${proposalLabel} is not local`);
    }
    if ((status === 'incoming-cached' || status === 'incoming-review') && origin !== 'peer') {
      throw new Error(`Garbled save: incoming ${proposalLabel} is not peer-originated`);
    }
    if (
      origin === 'local' &&
      (status === 'outgoing' || status === 'accepting' || status === 'advisory-cancelling')
    ) {
      localOutgoing += 1;
    }
    const handProposal = parseHandProposalSnapshot(
      saved.hand_proposal,
      `${proposalLabel}.hand_proposal`,
    );
    return {
      id,
      handProposal,
      origin,
      status,
    };
  });
  if (localOutgoing > 1) {
    throw new Error('Garbled save: multiple local outgoing proposal groups');
  }
  return proposals;
}
