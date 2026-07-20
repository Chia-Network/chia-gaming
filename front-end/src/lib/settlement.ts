/** Compact settlement outcome ids (snake_case; match Rust `SettlementOutcome`). */
export type SettlementOutcome =
  | 'accept_settlement'
  | 'settled_cleanly'
  | 'opponent_timed_out'
  | 'forfeited_skipped_reveal'
  | 'forfeited_opponent_won'
  | 'forfeited_we_accepted'
  | 'we_accepted'
  | 'attempt_to_move_failed'
  | 'timed_out_waiting_for_our_move'
  | 'slashed_opponent'
  | 'opponent_slashed_us'
  | 'opponent_cheated';

const ALL_OUTCOMES: ReadonlySet<string> = new Set<SettlementOutcome>([
  'accept_settlement',
  'settled_cleanly',
  'opponent_timed_out',
  'forfeited_skipped_reveal',
  'forfeited_opponent_won',
  'forfeited_we_accepted',
  'we_accepted',
  'attempt_to_move_failed',
  'timed_out_waiting_for_our_move',
  'slashed_opponent',
  'opponent_slashed_us',
  'opponent_cheated',
]);

/** Banner / dashboard display names from the settlement glossary. */
export const SETTLEMENT_OUTCOME_LABELS: Record<SettlementOutcome, string> = {
  accept_settlement: 'Accepted',
  settled_cleanly: 'Settled cleanly',
  opponent_timed_out: 'Opponent timed out',
  forfeited_skipped_reveal: 'Forfeited',
  forfeited_opponent_won: 'Forfeited',
  forfeited_we_accepted: 'Forfeited',
  we_accepted: 'Accepted',
  attempt_to_move_failed: 'Attempt to move failed',
  timed_out_waiting_for_our_move: 'Timed out waiting for our move',
  slashed_opponent: 'Slashed opponent',
  opponent_slashed_us: 'Opponent slashed us',
  opponent_cheated: 'Opponent cheated',
};

export function isSettlementOutcome(value: unknown): value is SettlementOutcome {
  return typeof value === 'string' && ALL_OUTCOMES.has(value);
}

export function settlementLabel(outcome: SettlementOutcome): string {
  return SETTLEMENT_OUTCOME_LABELS[outcome];
}

export function isForfeitOutcome(outcome: SettlementOutcome): boolean {
  return (
    outcome === 'forfeited_skipped_reveal'
    || outcome === 'forfeited_opponent_won'
    || outcome === 'forfeited_we_accepted'
  );
}

/** Outcomes that should surface as session-level error attention. */
export function isErrorSettlementOutcome(outcome: SettlementOutcome): boolean {
  return (
    isForfeitOutcome(outcome)
    || outcome === 'timed_out_waiting_for_our_move'
    || outcome === 'attempt_to_move_failed'
    || outcome === 'opponent_slashed_us'
    || outcome === 'opponent_cheated'
  );
}

/**
 * Rough "who caused it" for game UIs that still key off direction.
 * `null` means mutual / already-terminal / not directional.
 */
export function settlementByUs(outcome: SettlementOutcome): boolean | null {
  switch (outcome) {
    case 'accept_settlement':
    case 'we_accepted':
    case 'forfeited_skipped_reveal':
    case 'forfeited_opponent_won':
    case 'forfeited_we_accepted':
    case 'timed_out_waiting_for_our_move':
    case 'attempt_to_move_failed':
    case 'slashed_opponent':
      return true;
    case 'opponent_timed_out':
    case 'opponent_slashed_us':
    case 'opponent_cheated':
      return false;
    case 'settled_cleanly':
      return null;
  }
}

/** Calpoker timeout badge kind from a settlement outcome. */
export function calpokerTimeoutBadge(
  outcome: SettlementOutcome,
  side: 'ours' | 'theirs',
): 'winner' | 'timeout' | 'forfeit' | null {
  const byUs = settlementByUs(outcome);
  if (byUs == null) return null;
  if (side === 'ours') {
    if (byUs) return isForfeitOutcome(outcome) ? 'forfeit' : 'timeout';
    return 'winner';
  }
  if (!byUs) return isForfeitOutcome(outcome) ? 'forfeit' : 'timeout';
  return 'winner';
}

/** Short verb for Calpoker hand headers when a settlement ends the hand. */
export function calpokerSettlementVerb(outcome: SettlementOutcome): string {
  if (isForfeitOutcome(outcome)) return 'forfeited';
  if (outcome === 'attempt_to_move_failed') return 'moved too late';
  if (
    outcome === 'accept_settlement'
    || outcome === 'we_accepted'
    || outcome === 'settled_cleanly'
  ) {
    return 'settled';
  }
  if (outcome === 'slashed_opponent') return 'slashed opponent';
  if (outcome === 'opponent_slashed_us') return 'was slashed';
  if (outcome === 'opponent_cheated') return 'cheated';
  return 'timed out';
}

/** Short in-game status line for Krunk (and similar). */
export function krunkSettlementStatus(
  outcome: SettlementOutcome,
  opponentLabel: string,
): string {
  switch (outcome) {
    case 'accept_settlement':
    case 'we_accepted':
    case 'settled_cleanly':
      return 'Settled.';
    case 'opponent_timed_out':
      return `${opponentLabel} timed out.`;
    case 'forfeited_skipped_reveal':
    case 'forfeited_we_accepted':
    case 'forfeited_opponent_won':
      return 'We forfeited.';
    case 'attempt_to_move_failed':
      return 'Attempt to move failed.';
    case 'timed_out_waiting_for_our_move':
      return 'We timed out.';
    case 'slashed_opponent':
      return `Slashed ${opponentLabel}.`;
    case 'opponent_slashed_us':
      return `${opponentLabel} slashed us.`;
    case 'opponent_cheated':
      return `${opponentLabel} cheated.`;
  }
}

export function parseSettlementShare(value: unknown): string {
  if (value == null) return '0';
  if (typeof value === 'object' && value !== null && 'Amount' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>).Amount);
  }
  if (typeof value === 'object' && value !== null && 'amt' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>).amt);
  }
  return String(value);
}
