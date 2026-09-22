import { isCatalogGameType, isProposalParameterValue, validateHandProposal } from '../gameRegistry';
import type { SessionPresentationSave } from './saveEnvelope';
import type { HandProposal, PendingProposalModel } from './types';
import { isUncancelledProposalLifecycle } from './proposalPolicy';
import {
  requireBigint,
  requireBoolean,
  requireExactKeys,
  requireRecord,
  requireString,
} from './persistencePrimitives';

const COMPOSE_KEYS = new Set(['selectedGame', 'gameTimeout']);
const HAND_PROPOSAL_KEYS = new Set(['senderIsPlayerA', 'gameTimeout', 'gameType', 'parameters']);
const PENDING_PROPOSAL_KEYS = new Set(['id', 'lifecycle', 'handProposal']);

export function parseComposeDraftState(
  value: unknown,
): SessionPresentationSave['betweenHandCompose'] {
  const saved = requireRecord(value, 'betweenHandCompose');
  requireExactKeys(saved, COMPOSE_KEYS, 'betweenHandCompose');
  const selectedGame = saved.selectedGame;
  if (!isCatalogGameType(selectedGame)) {
    throw new Error('Garbled save: invalid betweenHandCompose.selectedGame');
  }
  return {
    selectedGame,
    gameTimeout: requireBigint(saved.gameTimeout, 'betweenHandCompose.gameTimeout'),
  };
}

export function parseHandProposalSnapshot(value: unknown, label: string): HandProposal {
  const saved = requireRecord(value, label);
  requireExactKeys(saved, HAND_PROPOSAL_KEYS, label);
  const gameType = saved.gameType;
  if (!isCatalogGameType(gameType)) {
    throw new Error(`Garbled save: unknown ${label}.gameType ${String(gameType)}`);
  }
  if (!isProposalParameterValue(saved.parameters)) {
    throw new Error(`Garbled save: invalid ${label}.parameters`);
  }
  const terms: HandProposal = {
    gameType,
    senderIsPlayerA: requireBoolean(saved.senderIsPlayerA, `${label}.senderIsPlayerA`),
    gameTimeout: requireBigint(saved.gameTimeout, `${label}.gameTimeout`, 1n),
    parameters: saved.parameters,
  };
  if (!validateHandProposal(terms)) {
    throw new Error(`Garbled save: invalid ${label} ${gameType} terms`);
  }
  return terms;
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
      saved.handProposal,
      `${proposalLabel}.handProposal`,
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
