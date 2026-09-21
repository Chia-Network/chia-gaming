import { isCatalogGameType, isProposalParameterValue, validateHandProposal } from '../gameRegistry';
import type { ComposeDraftState } from './composeDraft';
import type { SessionPresentationSave } from './saveEnvelope';
import type { HandProposal, PendingProposalModel } from './types';
import { isUncancelledProposalLifecycle } from './proposalPolicy';
import {
  parseDecimalString,
  requireBoolean,
  requireExactKeys,
  requireRecord,
  requireString,
} from './persistencePrimitives';

const COMPOSE_KEYS = new Set(['selected_game', 'game_timeout']);
const HAND_PROPOSAL_KEYS = new Set([
  'sender_is_player_a',
  'game_timeout',
  'game_type',
  'parameters',
]);
const PENDING_PROPOSAL_KEYS = new Set(['id', 'lifecycle', 'hand_proposal']);

export function encodeComposeDraftState(
  compose: ComposeDraftState,
): SessionPresentationSave['betweenHandCompose'] {
  return {
    selected_game: compose.selectedGame,
    game_timeout: compose.gameTimeout.toString(),
  };
}

export function parseComposeDraftState(value: unknown): ComposeDraftState {
  const saved = requireRecord(value, 'betweenHandCompose');
  requireExactKeys(saved, COMPOSE_KEYS, 'betweenHandCompose');
  const selectedGame = saved.selected_game;
  if (!isCatalogGameType(selectedGame)) {
    throw new Error('Garbled save: invalid betweenHandCompose.selected_game');
  }
  return {
    selectedGame: selectedGame,
    gameTimeout: parseDecimalString(saved.game_timeout, 'betweenHandCompose.game_timeout', 0n),
    proposalSent: false,
  };
}

export function parseHandProposalSnapshot(value: unknown, label: string): HandProposal {
  const saved = requireRecord(value, label);
  requireExactKeys(saved, HAND_PROPOSAL_KEYS, label);
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
  let uncancelled = 0;
  const proposals = value.map((entry, index): PendingProposalModel => {
    const proposalLabel = `${label}[${index}]`;
    const saved = requireRecord(entry, proposalLabel);
    requireExactKeys(saved, PENDING_PROPOSAL_KEYS, proposalLabel);
    const id = requireString(saved.id, `${proposalLabel}.id`);
    if (seen.has(id)) throw new Error(`Garbled save: duplicate pending proposal ${id}`);
    seen.add(id);
    const lifecycle = saved.lifecycle;
    if (
      lifecycle !== 'local-outgoing' &&
      lifecycle !== 'local-cancel-queued' &&
      lifecycle !== 'peer-cached' &&
      lifecycle !== 'peer-review' &&
      lifecycle !== 'peer-accept-queued' &&
      lifecycle !== 'peer-cancel-queued'
    ) {
      throw new Error(`Garbled save: invalid ${proposalLabel}.lifecycle`);
    }
    if (isUncancelledProposalLifecycle(lifecycle)) uncancelled += 1;
    const handProposal = parseHandProposalSnapshot(
      saved.hand_proposal,
      `${proposalLabel}.hand_proposal`,
    );
    return {
      id,
      handProposal,
      lifecycle,
    };
  });
  if (uncancelled > 1) {
    throw new Error('Garbled save: multiple uncancelled proposals');
  }
  return proposals;
}
