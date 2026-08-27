import { defaultFormatAmount } from '../../host';
import type { SpHandEntry, SpOutcome, SpTerminalState } from './useSpacepokerHand';

const RANK_LABELS: Record<number, string> = {
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: 'T',
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
};

const FULL_RANKS: Record<number, string> = {
  2: 'Two',
  3: 'Three',
  4: 'Four',
  5: 'Five',
  6: 'Six',
  7: 'Seven',
  8: 'Eight',
  9: 'Nine',
  10: 'Ten',
  11: 'Jack',
  12: 'Queen',
  13: 'King',
  14: 'Ace',
};

export function spacePokerRankLabel(rank: bigint): string {
  return RANK_LABELS[Number(rank)] ?? String(rank);
}

function fullRank(rank: bigint): string {
  return FULL_RANKS[Number(rank)] ?? String(rank);
}

function kickerSuffix(kickers: bigint[]): string {
  if (kickers.length === 0) return '';
  if (kickers.length === 1) return `. ${fullRank(kickers[0])} kicker`;
  return `. ${kickers.map(fullRank).join(', ')} kickers`;
}

// Eval format from space_hand_eval.clinc:
//   5 of a kind:  (5 boost rank)
//   4 of a kind:  (4 1 boost quad kicker)
//   straight:     (3 3 boost high)
//   full house:   (3 2 boost set pair)
//   set:          (3 1 1 boost set k1 k2)
//   two pair:     (2 2 1 boost hp lp k)
//   pair:         (2 1 1 1 boost pr k1 k2 k3)
//   high card:    (1 1 1 1 1 boost h k1 k2 k3 k4)
export function describeSpacePokerHand(eval_: bigint[]): string {
  if (!eval_ || eval_.length === 0) return '';
  const c0 = eval_[0];
  if (c0 === 5n) {
    const b = eval_[1],
      r = eval_[2];
    return b ? `Five of a Kind, Boosted, ${fullRank(r)}s` : `Five of a Kind, ${fullRank(r)}s`;
  }
  if (c0 === 4n && eval_[1] === 1n) {
    const b = eval_[2],
      r = eval_[3];
    return (
      (b ? `Four of a Kind, Boosted, ${fullRank(r)}s` : `Four of a Kind, ${fullRank(r)}s`) +
      kickerSuffix([eval_[4]])
    );
  }
  if (c0 === 3n && eval_[1] === 3n) {
    const b = eval_[2],
      r = eval_[3];
    return b ? `Straight, Boosted, ${fullRank(r)} high` : `Straight, ${fullRank(r)} high`;
  }
  if (c0 === 3n && eval_[1] === 2n) {
    const b = eval_[2],
      s = eval_[3],
      p = eval_[4];
    return b
      ? `Full House, Boosted, ${fullRank(s)}s full of ${fullRank(p)}s`
      : `Full House, ${fullRank(s)}s full of ${fullRank(p)}s`;
  }
  if (c0 === 3n && eval_[1] === 1n && eval_[2] === 1n) {
    const b = eval_[3],
      r = eval_[4];
    return (
      (b ? `Three of a Kind, Boosted, ${fullRank(r)}s` : `Three of a Kind, ${fullRank(r)}s`) +
      kickerSuffix(eval_.slice(5))
    );
  }
  if (c0 === 2n && eval_[1] === 2n && eval_[2] === 1n) {
    const b = eval_[3],
      hp = eval_[4],
      lp = eval_[5];
    return (
      (b
        ? `Two Pair, Boosted, ${fullRank(hp)}s and ${fullRank(lp)}s`
        : `Two Pair, ${fullRank(hp)}s and ${fullRank(lp)}s`) + kickerSuffix([eval_[6]])
    );
  }
  if (c0 === 2n && eval_[1] === 1n && eval_[2] === 1n && eval_[3] === 1n) {
    const b = eval_[4],
      r = eval_[5];
    return (
      (b ? `Pair, Boosted, ${fullRank(r)}s` : `Pair of ${fullRank(r)}s`) +
      kickerSuffix(eval_.slice(6))
    );
  }
  if (c0 === 1n && eval_[1] === 1n && eval_[2] === 1n && eval_[3] === 1n && eval_[4] === 1n) {
    const b = eval_[5],
      r = eval_[6];
    return (
      (b ? `Boosted, ${fullRank(r)} high` : `${fullRank(r)} high`) + kickerSuffix(eval_.slice(7))
    );
  }
  return eval_.join(' ');
}

function logHoleCards(cards: [bigint, bigint], boost: boolean): string {
  return `${spacePokerRankLabel(cards[0])}${spacePokerRankLabel(cards[1])}${boost ? '+' : '-'}`;
}

function logBestHand(cards: bigint[], boost: boolean): string {
  return cards.map((card) => spacePokerRankLabel(card)).join('') + (boost ? '+' : '-');
}

export function formatSpacepokerHandLog(
  playerHoleCards: [bigint, bigint],
  playerBoost: boolean,
  opponentHoleCards: [bigint, bigint] | null,
  opponentBoost: boolean | null,
  communityCards: (bigint | null)[],
  handHistory: SpHandEntry[],
  outcome: SpOutcome | null,
  terminalState: SpTerminalState,
  coinTossIOpen: boolean | null,
  betUnit: bigint,
  stackSize: bigint,
  formatAmount: (mojos: bigint) => string = defaultFormatAmount,
): string[] {
  const weOpenFirst = coinTossIOpen === true;
  const posLabel = weOpenFirst ? '1st' : '2nd';
  const items: string[] = [];
  let ourTotal = 1n;
  let theirTotal = 1n;
  let nextRevealIdx = 0;

  for (const entry of handHistory) {
    const isUs = entry.player === 'you';

    if (entry.action === 'fold' || entry.action === 'failed') {
      items.push('\u274C');
      continue;
    }
    if (entry.action === 'concede') {
      items.push('\u{1F3F3}\uFE0F');
      continue;
    }
    if (entry.action === 'reveal') {
      if (!isUs && opponentHoleCards) {
        items.push('\u{1F440}' + logHoleCards(opponentHoleCards, opponentBoost ?? false));
      }
      continue;
    }

    if (entry.action === 'raise') {
      const units = entry.units ?? 0n;
      if (isUs) {
        ourTotal += units;
      } else {
        theirTotal += units;
      }
      if ((isUs && ourTotal >= stackSize) || (!isUs && theirTotal >= stackSize)) {
        items.push('all');
      } else {
        items.push(String(units));
      }
    } else {
      if (entry.action === 'call') {
        const gap = isUs ? theirTotal - ourTotal : ourTotal - theirTotal;
        if (gap > 0n) {
          if (isUs) ourTotal += gap;
          else theirTotal += gap;
        }
      }
      items.push('\u2705');
    }

    if (entry.endsStreet || entry.action === 'call') {
      if (nextRevealIdx === 0) {
        const flop = communityCards.slice(0, 3).filter((card): card is bigint => card != null);
        if (flop.length > 0) {
          items.push('\u270B' + flop.map((card) => spacePokerRankLabel(card)).join(''));
          nextRevealIdx = 1;
        }
      } else if (nextRevealIdx === 1) {
        const turn = communityCards[3];
        if (turn != null) {
          items.push('\u270B' + spacePokerRankLabel(turn));
          nextRevealIdx = 2;
        }
      } else if (nextRevealIdx === 2) {
        const river = communityCards[4];
        if (river != null) {
          items.push('\u270B' + spacePokerRankLabel(river));
          nextRevealIdx = 3;
        }
      }
    }
  }

  const lastItem = items[items.length - 1];
  const oppRevealed = terminalState === 'revealed' && opponentHoleCards;
  if (oppRevealed) {
    const oppStr = '\u{1F440}' + logHoleCards(opponentHoleCards, opponentBoost ?? false);
    if (lastItem !== oppStr && lastItem !== '\u{1F3F3}\uFE0F' && lastItem !== '\u274C') {
      items.push(oppStr);
    }
  }

  let actionLine = `${logHoleCards(playerHoleCards, playerBoost)} ${posLabel}`;
  for (let i = 0; i < items.length; i++) {
    if (i === 0) {
      actionLine += '  ';
    } else {
      const gapIdx = i - 1;
      const isDouble = weOpenFirst ? gapIdx % 2 !== 0 : gapIdx % 2 === 0;
      actionLine += isDouble ? '  ' : ' ';
    }
    actionLine += items[i];
  }

  let resultLine = '';
  if (terminalState === 'folded-by-you') {
    const lost = ourTotal;
    resultLine = `Lose ${lost} (${formatAmount(lost * betUnit)})`;
  } else if (
    terminalState === 'folded-by-opponent' ||
    terminalState === 'won-by-opponent-failure'
  ) {
    const won = theirTotal;
    resultLine = `Win ${won} (${formatAmount(won * betUnit)})`;
  } else if (terminalState === 'conceded-by-opponent') {
    const won = theirTotal;
    resultLine = `Win ${won} (${formatAmount(won * betUnit)})`;
    if (outcome?.playerHandCards && outcome.playerHandCards.length > 0) {
      resultLine += ` with ${logBestHand(outcome.playerHandCards, playerBoost)}`;
    }
  } else if (terminalState === 'conceded-by-you') {
    const lost = ourTotal;
    resultLine = `Lose ${lost} (${formatAmount(lost * betUnit)})`;
  } else if (terminalState === 'revealed' && outcome) {
    if (outcome.result > 0n) {
      const won = theirTotal;
      resultLine = `Win ${won} (${formatAmount(won * betUnit)})`;
    } else if (outcome.result < 0n) {
      const lost = ourTotal;
      resultLine = `Lose ${lost} (${formatAmount(lost * betUnit)})`;
    } else {
      resultLine = 'Split';
    }
    if (outcome.playerHandCards && outcome.playerHandCards.length > 0) {
      resultLine += ` with ${logBestHand(outcome.playerHandCards, playerBoost)}`;
    }
    if (outcome.opponentHandCards && outcome.opponentHandCards.length > 0) {
      resultLine += ` vs ${logBestHand(outcome.opponentHandCards, opponentBoost ?? false)}`;
    }
  }

  return [actionLine, resultLine];
}
