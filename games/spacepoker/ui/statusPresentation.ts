import type { SettlementOutcome } from '../../host';
import { isTerminalSpacepokerHandler, SpHandler, type SpTerminalState } from './useSpacepokerHand';

export type HoleCardsBannerKind = 'fold' | 'concede' | 'win' | 'tie' | null;

const SETTLEMENT_LABELS: Record<SettlementOutcome, string> = {
  accept_settlement: 'Accepted',
  settled_cleanly: 'Settled cleanly',
  opponent_timed_out: 'Opponent timed out',
  forfeited_skipped_reveal: 'Forfeited',
  lost: 'Lost',
  forfeited_we_accepted: 'Forfeited',
  we_accepted: 'Accepted',
  attempt_to_move_failed: 'Attempt to move failed',
  timed_out_waiting_for_our_move: 'Timed out waiting for our move',
  slashed_opponent: 'Slashed opponent',
  opponent_slashed_us: 'Opponent slashed us',
  opponent_cheated: 'Opponent cheated',
};

export function spacePokerTerminalBanners(
  terminalState: SpTerminalState,
  showdownResult: bigint | null,
): { player: HoleCardsBannerKind; opponent: HoleCardsBannerKind } {
  if (terminalState === 'conceded-by-you') return { player: null, opponent: 'win' };
  if (terminalState === 'conceded-by-opponent') return { player: 'win', opponent: null };
  if (terminalState === 'folded-by-you') return { player: 'fold', opponent: null };
  if (terminalState === 'folded-by-opponent') return { player: null, opponent: 'fold' };
  if (terminalState === 'won-by-opponent-failure') return { player: 'win', opponent: null };
  if (showdownResult === null) return { player: null, opponent: null };
  if (showdownResult > 0n) return { player: 'win', opponent: null };
  if (showdownResult < 0n) return { player: null, opponent: 'win' };
  return { player: 'tie', opponent: 'tie' };
}

export function spacePokerTerminalIndicators(
  terminalState: SpTerminalState,
  showdownResult: bigint | null,
): { player: string; opponent: string } {
  if (terminalState === 'conceded-by-opponent') {
    return { player: ' \u2705', opponent: ' \u{1F3F3}\uFE0F' };
  }
  if (terminalState === 'conceded-by-you') {
    return { player: ' \u{1F3F3}\uFE0F', opponent: ' \u2705' };
  }
  if (terminalState === 'folded-by-you') {
    return { player: ' \u274C', opponent: ' \u2705' };
  }
  if (terminalState === 'folded-by-opponent' || terminalState === 'won-by-opponent-failure') {
    return { player: ' \u2705', opponent: ' \u274C' };
  }
  if (showdownResult === null) return { player: '', opponent: '' };
  return {
    player: showdownResult > 0n ? ' \u2705' : showdownResult < 0n ? ' \u274C' : '',
    opponent: showdownResult < 0n ? ' \u2705' : showdownResult > 0n ? ' \u274C' : '',
  };
}

export function spacePokerFooterStatus(handler: SpHandler, turnLine: string): string {
  return isTerminalSpacepokerHandler(handler) ? '' : turnLine;
}

export function spacePokerTransitionCommentary(handler: SpHandler, myTurn: boolean): string {
  if (handler === SpHandler.CommitA || handler === SpHandler.CommitB) return 'Dealing cards…';
  if (handler === SpHandler.End) {
    return myTurn ? 'Finishing hand…' : 'Waiting for opponent to finish…';
  }
  return '';
}

export function spacePokerTurnLine(
  handler: SpHandler,
  myTurn: boolean,
  round: bigint,
  coinTossIOpen: boolean | null,
  lastRaise: bigint,
  formatBet: (units: bigint) => string,
): string {
  const inBetting = handler === SpHandler.BeginRound || handler === SpHandler.MidRound;
  if (
    myTurn &&
    inBetting &&
    !(handler === SpHandler.BeginRound && round === 4n && coinTossIOpen === false)
  ) {
    return handler === SpHandler.MidRound && lastRaise > 0n
      ? `Your turn, ${formatBet(lastRaise)} to call`
      : 'Your turn';
  }
  if (myTurn && handler === SpHandler.BeginRound && round === 4n && coinTossIOpen === false) {
    return 'Coin toss: opponent opens\u2026';
  }
  if (!myTurn && inBetting) return 'Waiting for opponent\u2026';
  return spacePokerTransitionCommentary(handler, myTurn);
}

export function spacePokerTerminalCommentary(
  terminalState: SpTerminalState,
  showdownResult: bigint | null,
  terminalOutcome: SettlementOutcome | null,
): string {
  if (terminalState === 'conceded-by-opponent') {
    return 'You revealed first and the opponent conceded.';
  }
  if (terminalState === 'conceded-by-you') {
    return 'The opponent revealed first and you conceded.';
  }
  if (terminalState === 'folded-by-opponent') return 'The opponent folded. You won the hand.';
  if (terminalState === 'folded-by-you') return 'You folded. The opponent won the hand.';
  if (terminalState === 'won-by-opponent-failure') {
    return "The opponent's final action failed. You won the hand.";
  }
  if (terminalState === 'revealed' && showdownResult !== null) {
    if (showdownResult > 0n) return 'You won at showdown.';
    if (showdownResult < 0n) return 'The opponent won at showdown.';
    return 'The showdown ended in a tie.';
  }
  if (terminalOutcome !== null) return `${SETTLEMENT_LABELS[terminalOutcome]}.`;
  if (terminalState !== 'none') return 'The hand ended.';
  return '';
}
