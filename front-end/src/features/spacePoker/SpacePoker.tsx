import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Observable } from 'rxjs';
import { SessionController } from '../../hooks/SessionController';
import {
  useSpacepokerHand,
  SpHandler,
  SpHandEntry,
  SpOutcome,
  SpTerminalState,
  SpacepokerDisplayMode,
  SpacepokerHandState,
} from './useSpacepokerHand';
import { RawGameNotification } from '../../hooks/useGameSession';
import { useCheatNerfKeys } from './useCheatNerfKeys';
import type { SpacepokerSettlementOutcome } from './handState';
import { isSpacepokerTimeoutOrForfeit, spacepokerTerminalBadge } from './terminal';
import { formatAmount } from '../../util';

const RANK_LABELS: Record<number, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

const FULL_RANKS: Record<number, string> = {
  2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven',
  8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace',
};

function rankLabel(rank: bigint): string {
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
function describeHand(eval_: bigint[]): string {
  if (!eval_ || eval_.length === 0) return '';
  const c0 = eval_[0];
  if (c0 === 5n) {
    const b = eval_[1], r = eval_[2];
    return b ? `Five of a Kind, Boosted, ${fullRank(r)}s` : `Five of a Kind, ${fullRank(r)}s`;
  }
  if (c0 === 4n && eval_[1] === 1n) {
    const b = eval_[2], r = eval_[3];
    return (b ? `Four of a Kind, Boosted, ${fullRank(r)}s` : `Four of a Kind, ${fullRank(r)}s`) + kickerSuffix([eval_[4]]);
  }
  if (c0 === 3n && eval_[1] === 3n) {
    const b = eval_[2], r = eval_[3];
    return b ? `Straight, Boosted, ${fullRank(r)} high` : `Straight, ${fullRank(r)} high`;
  }
  if (c0 === 3n && eval_[1] === 2n) {
    const b = eval_[2], s = eval_[3], p = eval_[4];
    return b
      ? `Full House, Boosted, ${fullRank(s)}s full of ${fullRank(p)}s`
      : `Full House, ${fullRank(s)}s full of ${fullRank(p)}s`;
  }
  if (c0 === 3n && eval_[1] === 1n && eval_[2] === 1n) {
    const b = eval_[3], r = eval_[4];
    return (b ? `Three of a Kind, Boosted, ${fullRank(r)}s` : `Three of a Kind, ${fullRank(r)}s`) + kickerSuffix(eval_.slice(5));
  }
  if (c0 === 2n && eval_[1] === 2n && eval_[2] === 1n) {
    const b = eval_[3], hp = eval_[4], lp = eval_[5];
    return (b
      ? `Two Pair, Boosted, ${fullRank(hp)}s and ${fullRank(lp)}s`
      : `Two Pair, ${fullRank(hp)}s and ${fullRank(lp)}s`) + kickerSuffix([eval_[6]]);
  }
  if (c0 === 2n && eval_[1] === 1n && eval_[2] === 1n && eval_[3] === 1n) {
    const b = eval_[4], r = eval_[5];
    return (b ? `Pair, Boosted, ${fullRank(r)}s` : `Pair of ${fullRank(r)}s`) + kickerSuffix(eval_.slice(6));
  }
  if (c0 === 1n && eval_[1] === 1n && eval_[2] === 1n && eval_[3] === 1n && eval_[4] === 1n) {
    const b = eval_[5], r = eval_[6];
    return (b ? `Boosted, ${fullRank(r)} high` : `${fullRank(r)} high`) + kickerSuffix(eval_.slice(7));
  }
  return eval_.join(' ');
}

// ── Hand history log formatting ──

const LOG_RANKS: Record<number, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

function logRank(rank: bigint): string {
  return LOG_RANKS[Number(rank)] ?? String(rank);
}

function logHoleCards(cards: [bigint, bigint], boost: boolean): string {
  return `${logRank(cards[0])}${logRank(cards[1])}${boost ? '+' : '-'}`;
}

function logBestHand(cards: bigint[], boost: boolean): string {
  return cards.map(c => logRank(c)).join('') + (boost ? '+' : '-');
}

function formatSpacepokerHandLog(
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
): string[] {
  const weOpenFirst = coinTossIOpen === true;
  const posLabel = weOpenFirst ? '1st' : '2nd';

  // Build the flat item list from the hand history.
  // Track each player's cumulative bet to detect all-in.
  const items: string[] = [];
  let ourTotal = 1n; // ante
  let theirTotal = 1n; // ante
  let nextRevealIdx = 0; // 0=flop(3 cards), 1=turn, 2=river

  for (let i = 0; i < handHistory.length; i++) {
    const entry = handHistory[i];
    const isUs = entry.player === 'you';

    if (entry.action === 'fold') {
      items.push('\u274C');
      continue;
    }
    if (entry.action === 'concede') {
      items.push('\u{1F3F3}\uFE0F');
      continue;
    }
    if (entry.action === 'reveal') {
      if (isUs) {
        // Our reveal at showdown — not an item in the log; the result line covers it.
        continue;
      }
      // Opponent reveal: show eyes + their hole cards
      if (opponentHoleCards) {
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
      // check or call — both rendered as checkmark
      if (entry.action === 'call') {
        // A call matches the outstanding raise; add it to the caller's total.
        // The raise amount isn't on this entry, but we can infer it: the
        // difference between the two players' totals before this call.
        const gap = isUs
          ? theirTotal - ourTotal
          : ourTotal - theirTotal;
        if (gap > 0n) {
          if (isUs) ourTotal += gap;
          else theirTotal += gap;
        }
      }
      items.push('\u2705');
    }

    // After a street-ending action, insert the next community card reveal.
    if (entry.endsStreet || entry.action === 'call') {
      if (nextRevealIdx === 0) {
        // Flop: 3 cards
        const flop = communityCards.slice(0, 3).filter((c): c is bigint => c != null);
        if (flop.length > 0) {
          items.push('\u270B' + flop.map(c => logRank(c)).join(''));
          nextRevealIdx = 1;
        }
      } else if (nextRevealIdx === 1) {
        // Turn
        const turn = communityCards[3];
        if (turn != null) {
          items.push('\u270B' + logRank(turn));
          nextRevealIdx = 2;
        }
      } else if (nextRevealIdx === 2) {
        // River
        const river = communityCards[4];
        if (river != null) {
          items.push('\u270B' + logRank(river));
          nextRevealIdx = 3;
        }
      }
    }
  }

  // If opponent's hole cards were revealed at showdown but no 'reveal' entry
  // was in the history (e.g. the call at showdown carried the reveal data),
  // append them with the eyes prefix.
  const lastItem = items[items.length - 1];
  const oppRevealed = terminalState === 'revealed' && opponentHoleCards;
  if (oppRevealed) {
    const oppStr = '\u{1F440}' + logHoleCards(opponentHoleCards!, opponentBoost ?? false);
    if (lastItem !== oppStr && lastItem !== '\u{1F3F3}\uFE0F' && lastItem !== '\u274C') {
      items.push(oppStr);
    }
  }

  // Apply spacing.  After the position label there is always a double space.
  // Between successive items the gap alternates:
  //   1st: single, double, single, double, ...
  //   2nd: double, single, double, single, ...
  let actionLine = `${logHoleCards(playerHoleCards, playerBoost)} ${posLabel}`;
  for (let i = 0; i < items.length; i++) {
    if (i === 0) {
      actionLine += '  '; // always double after position label
    } else {
      // Gap index (i-1) determines double/single.
      // 1st: gap0 (between item0–item1) = single, gap1 = double, ...
      //   → even gap index = single, odd = double
      // 2nd: gap0 = double, gap1 = single, ...
      //   → even gap index = double, odd = single
      const gapIdx = i - 1;
      const isDouble = weOpenFirst ? (gapIdx % 2 !== 0) : (gapIdx % 2 === 0);
      actionLine += isDouble ? '  ' : ' ';
    }
    actionLine += items[i];
  }

  // Build result line
  let resultLine = '';
  if (terminalState === 'folded-by-you') {
    // We folded: compute how much we lost
    const lost = ourTotal;
    const lostMojos = lost * betUnit;
    resultLine = `Lose ${lost} (${formatAmount(lostMojos)})`;
  } else if (terminalState === 'folded-by-opponent') {
    // They folded: compute how much we won
    const won = theirTotal;
    const wonMojos = won * betUnit;
    resultLine = `Win ${won} (${formatAmount(wonMojos)})`;
  } else if (terminalState === 'conceded-by-opponent') {
    // They conceded at showdown: we win the pot
    const won = theirTotal;
    const wonMojos = won * betUnit;
    resultLine = `Win ${won} (${formatAmount(wonMojos)})`;
    if (outcome?.playerHandCards && outcome.playerHandCards.length > 0) {
      resultLine += ` with ${logBestHand(outcome.playerHandCards, playerBoost)}`;
    }
  } else if (terminalState === 'conceded-by-you') {
    // We conceded at showdown
    const lost = ourTotal;
    const lostMojos = lost * betUnit;
    resultLine = `Lose ${lost} (${formatAmount(lostMojos)})`;
  } else if (terminalState === 'revealed' && outcome) {
    const r = outcome.result;
    if (r > 0n) {
      const won = theirTotal;
      const wonMojos = won * betUnit;
      resultLine = `Win ${won} (${formatAmount(wonMojos)})`;
    } else if (r < 0n) {
      const lost = ourTotal;
      const lostMojos = lost * betUnit;
      resultLine = `Lose ${lost} (${formatAmount(lostMojos)})`;
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

const SEL_BAR = 'w-full h-1 rounded-full';
const SEL_VIS = `${SEL_BAR} bg-canvas-text-contrast`;
const SEL_HIDDEN = `${SEL_BAR} bg-transparent`;

function SpCard({ rankLabelText, faceDown }: { rankLabelText?: string; faceDown?: boolean }) {
  const base = 'inline-flex items-center justify-center rounded border text-lg font-bold select-none';
  const size = 'w-10 h-14 sm:w-12 sm:h-16';
  if (faceDown) {
    return (
      <div className={`${base} ${size} bg-canvas-solid border-canvas-line text-canvas-bg`}>?</div>
    );
  }
  return (
    <div className={`${base} ${size} bg-canvas-bg border-2 border-canvas-text-contrast text-canvas-text-contrast`}>
      {rankLabelText ?? ''}
    </div>
  );
}

function CardSlot() {
  return (
    <div className='inline-flex items-center justify-center rounded border border-dashed border-canvas-line w-10 h-14 sm:w-12 sm:h-16 text-canvas-text opacity-30' />
  );
}

function CardColumn({
  topSel,
  bottomSel,
  children,
}: {
  topSel?: boolean;
  bottomSel?: boolean;
  children: ReactNode;
}) {
  return (
    <div className='flex flex-col items-center gap-0.5'>
      <div className={topSel ? SEL_VIS : SEL_HIDDEN} />
      {children}
      <div className={bottomSel ? SEL_VIS : SEL_HIDDEN} />
    </div>
  );
}

type HoleCardsBannerKind = 'fold' | 'concede' | 'win' | 'tie' | 'timeout' | 'forfeit' | null;

function HoleCardsGroup({
  boosted,
  banner,
  children,
}: {
  boosted?: boolean;
  banner?: HoleCardsBannerKind;
  children: ReactNode;
}) {
  return (
    <div className='relative inline-flex items-center'>
      <div className='flex gap-2 items-center'>{children}</div>
      {boosted && (
        <span className='absolute left-full top-1/2 -translate-y-1/2 ml-1 text-2xl font-bold text-canvas-text-contrast leading-none'>
          +
        </span>
      )}
      {banner && (
        <span
          className={`absolute left-full top-1/2 -translate-y-1/2 ${boosted ? 'ml-6' : 'ml-2'} whitespace-nowrap rounded-full px-4 py-2 text-base font-bold shadow-lg ${
            banner === 'win'
              ? 'bg-primary-solid text-primary-on-primary'
              : 'bg-canvas-solid text-canvas-on-canvas'
          }`}
        >
          {banner === 'win'
            ? 'Winner!'
            : banner === 'tie'
              ? 'Tie'
              : banner === 'concede'
                ? 'Concede'
                : banner === 'timeout'
                  ? 'Timed Out'
                  : banner === 'forfeit'
                    ? 'Forfeit'
                    : 'Fold'}
        </span>
      )}
    </div>
  );
}

function AmountBadge({ children }: { children: ReactNode }) {
  return (
    <span className='font-bold text-lg text-canvas-text-contrast tabular-nums'>
      {children}
    </span>
  );
}

function entrySymbol(entry: SpHandEntry, formatBet: (units: bigint) => string): string {
  if (entry.action === 'check') return entry.endsStreet ? '\u270B' : '\u2705';
  if (entry.action === 'call') return '\u270B';
  if (entry.action === 'fold') return '\u274C';
  if (entry.action === 'concede') return '\u{1F3F3}\uFE0F';
  if (entry.action === 'reveal') return '\u{1F440}';
  return formatBet(entry.units ?? 0n);
}

function buildHistoryRows(history: SpHandEntry[], formatBet: (units: bigint) => string): [string | null, string | null][] {
  if (history.length === 0) return [];
  const rows: [string | null, string | null][] = [];
  let i = 0;
  if (history[0].player === 'opponent') {
    rows.push([null, entrySymbol(history[0], formatBet)]);
    i = 1;
  }
  for (; i < history.length; i += 2) {
    rows.push([
      entrySymbol(history[i], formatBet),
      history[i + 1] ? entrySymbol(history[i + 1], formatBet) : null,
    ]);
  }
  return rows;
}

function HandHistoryPanel({ rows }: { rows: [string | null, string | null][] }) {
  if (rows.length === 0) return null;
  return (
    <table className='text-base mx-auto table-auto'>
      <tbody>
        {rows.map(([left, right], i) => (
          <tr key={i} className={i > 0 ? 'border-t border-canvas-line' : ''}>
            <td className='px-3 py-1 text-canvas-text-contrast text-center min-w-12 whitespace-nowrap tabular-nums'>
              {left ?? ''}
            </td>
            <td className='px-3 py-1 text-canvas-text-contrast text-center min-w-12 whitespace-nowrap tabular-nums'>
              {right ?? ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface ActionBarProps {
  handler: SpHandler;
  myTurn: boolean;
  round: string;
  coinTossIOpen: boolean | null;
  lastRaiseUnits: string;
  maxRaiseUnits: string;
  formatBet: (units: bigint) => string;
  handleCheck: () => void;
  handleRaise: (units: bigint) => void;
  handleCall: () => void;
  handleFold: () => void;
}

function ActionBar({
  handler,
  myTurn,
  round,
  coinTossIOpen,
  lastRaiseUnits,
  maxRaiseUnits,
  formatBet,
  handleCheck,
  handleRaise,
  handleCall,
  handleFold,
}: ActionBarProps) {
  const [raiseAmount, setRaiseAmount] = useState(1);
  const inBetting = handler === SpHandler.BeginRound || handler === SpHandler.MidRound;
  const maxRaiseInput = Math.max(1, Number(maxRaiseUnits));
  const raiseAmountInput = Math.min(raiseAmount, maxRaiseInput);
  const isBeginRound = handler === SpHandler.BeginRound;
  const autoPong = isBeginRound && round === '4' && coinTossIOpen === false;
  const actionsEnabled = myTurn && inBetting && !autoPong;
  const checkCallLabel = handler === SpHandler.MidRound && lastRaiseUnits !== '0' ? 'Call' : 'Check';

  useEffect(() => {
    if (!actionsEnabled) {
      setRaiseAmount(1);
    }
  }, [actionsEnabled]);

  const doRaise = useCallback(() => {
    if (!actionsEnabled || raiseAmountInput < 1 || raiseAmountInput > Number(maxRaiseUnits)) return;
    handleRaise(BigInt(raiseAmountInput));
  }, [actionsEnabled, raiseAmountInput, maxRaiseUnits, handleRaise]);

  const btnClass =
    'px-3 py-1.5 rounded bg-primary-solid text-primary-on-primary text-sm font-medium hover:bg-primary-solid-hover disabled:opacity-40';

  return (
    <div className='flex flex-wrap items-center justify-center gap-2'>
      {isBeginRound ? (
        <button onClick={handleCheck} disabled={!actionsEnabled} className={`${btnClass} w-16`}>
          Check
        </button>
      ) : (
        <button onClick={handleCall} disabled={!actionsEnabled} className={`${btnClass} w-16`}>
          {checkCallLabel}
        </button>
      )}
      <div className='flex items-center gap-1'>
        <button onClick={doRaise} disabled={!actionsEnabled || Number(maxRaiseUnits) < 1} className={btnClass}>
          Raise
        </button>
        <input
          type='range'
          min={1}
          max={maxRaiseInput}
          value={raiseAmountInput}
          onChange={(e) => setRaiseAmount(Number(e.target.value))}
          disabled={!actionsEnabled}
          className='w-20 sm:w-32 disabled:opacity-40'
        />
        <span className='text-xs text-canvas-text-contrast w-16 text-center'>{formatBet(BigInt(raiseAmountInput))}</span>
      </div>
      <button onClick={handleFold} disabled={!actionsEnabled || isBeginRound} className={btnClass}>
        Fold
      </button>
    </div>
  );
}

export interface SpacePokerProps {
  gameObject: SessionController;
  gameId: string;
  iStarted: boolean;
  gameplayEvent$: Observable<RawGameNotification>;
  betSize: string;
  unitSizeMojos?: string;
  onTurnChanged: (isMyTurn: boolean) => void;
  onGameLog: (lines: string[]) => void;
  myName?: string;
  opponentName?: string;
  /** Frozen remount: session terminal when handState omitted the label. */
  settlementOutcome?: SpacepokerSettlementOutcome | null;
}

export default function SpacePoker({
  gameObject,
  gameId,
  iStarted,
  gameplayEvent$,
  betSize,
  unitSizeMojos,
  onTurnChanged,
  onGameLog,
  myName,
  opponentName,
  settlementOutcome: settlementOutcomeOverride = null,
}: SpacePokerProps) {
  const betSizeValue = BigInt(betSize);
  const unitSizeMojosValue = unitSizeMojos ? BigInt(unitSizeMojos) : undefined;
  const sp = useSpacepokerHand(
    gameObject,
    gameId,
    iStarted,
    gameplayEvent$,
    betSizeValue,
    unitSizeMojosValue,
    onTurnChanged,
    gameObject.handState ?? undefined,
    settlementOutcomeOverride,
  );
  const { handler, myTurn, N } = sp.gameState;

  const handleCheat = useCallback(() => {
    if (!gameObject || !gameId) return;
    gameObject.cheat(gameId, 0n);
    // A cheat is just an (illegal) move; drive the same turn-change path a
    // normal move uses so the status shows "Playing our move on-chain" while
    // it lands, instead of staying on our turn.
    onTurnChanged(false);
  }, [gameObject, gameId, onTurnChanged]);
  const handleNerf = useCallback(() => {
    if (!gameObject) return;
    gameObject.nerf();
  }, [gameObject]);
  useCheatNerfKeys(handleCheat, handleNerf);

  // Write to the session history panel when the hand finishes.
  // If restoring from a persisted terminal state, skip logging (already logged).
  const [alreadyTerminalAtMount] = useState(() => {
    const hs = gameObject.handState;
    if (!hs || hs.gameType !== 'spacepoker') return false;
    const s = hs.state as SpacepokerHandState | undefined;
    return s?.terminalState != null && s.terminalState !== 'none';
  });
  const gameLogFiredRef = useRef(alreadyTerminalAtMount);
  useEffect(() => {
    if (sp.terminalState === 'none' || gameLogFiredRef.current) return;
    if (!sp.playerHoleCards) return;
    gameLogFiredRef.current = true;
    const stackSize = sp.betUnit > 0n ? betSizeValue / sp.betUnit : 0n;
    const lines = formatSpacepokerHandLog(
      sp.playerHoleCards,
      sp.playerBoost,
      sp.opponentHoleCards,
      sp.opponentBoost,
      sp.communityCards,
      sp.handHistory,
      sp.outcome,
      sp.terminalState,
      sp.coinTossIOpen,
      sp.betUnit,
      stackSize,
    );
    onGameLog(lines);
  }, [sp.terminalState, sp.playerHoleCards, sp.playerBoost, sp.opponentHoleCards,
      sp.opponentBoost, sp.communityCards, sp.handHistory, sp.outcome,
      sp.coinTossIOpen, sp.betUnit, betSizeValue, onGameLog]);

  const communitySlots = 5;
  const communityReversed = [...sp.communityCards];

  const playerName = myName ?? 'You';
  const oppName = opponentName ?? 'Opponent';

  const inBetting = handler === SpHandler.BeginRound || handler === SpHandler.MidRound;
  const maxRaise = sp.playerStack - (sp.lastRaise > 0n ? sp.lastRaise : 0n);
  const historyRows = buildHistoryRows(sp.handHistory, sp.formatBet);
  const showdownOutcome = sp.outcome;
  const hasShowdownOutcome = !!showdownOutcome;
  const showPrivateShowdown =
    sp.terminalState === 'revealed' ||
    hasShowdownOutcome;

  const oppHandDesc =
    showPrivateShowdown && sp.outcome?.opponentHandEval && sp.outcome.opponentHandEval.length > 0
      ? describeHand(sp.outcome.opponentHandEval)
      : '';
  const playerHandDesc =
    showPrivateShowdown && sp.outcome?.playerHandEval && sp.outcome.playerHandEval.length > 0
      ? describeHand(sp.outcome.playerHandEval)
      : '';

  const finished = handler === SpHandler.Showdown || handler === SpHandler.Folded;
  let playerIndicator = '';
  let oppIndicator = '';
  if (hasShowdownOutcome && (finished || handler === SpHandler.End)) {
    playerIndicator = showdownOutcome.result > 0n ? ' \u2705' : showdownOutcome.result < 0n ? ' \u274C' : '';
    oppIndicator = showdownOutcome.result < 0n ? ' \u2705' : showdownOutcome.result > 0n ? ' \u274C' : '';
  } else if (sp.terminalState === 'conceded-by-opponent') {
    playerIndicator = ' \u2705';
    oppIndicator = ' \u274C';
  } else if (sp.terminalState === 'conceded-by-you') {
    playerIndicator = ' \u274C';
    oppIndicator = ' \u2705';
  } else if (sp.terminalState === 'folded-by-you') {
    playerIndicator = ' \u274C';
    oppIndicator = ' \u2705';
  } else if (sp.terminalState === 'folded-by-opponent') {
    playerIndicator = ' \u2705';
    oppIndicator = ' \u274C';
  }

  const settlementNote =
    hasShowdownOutcome
      ? ''
      : sp.terminalState === 'conceded-by-opponent'
        ? 'You revealed first and the opponent conceded.'
        : sp.terminalState === 'conceded-by-you'
          ? 'The opponent revealed first and you conceded.'
          : '';

  // Calpoker-style pill banners shown immediately to the right of each player's
  // hole cards. Timeout/forfeit settlements prefer Timed Out / Forfeit over Fold.
  let playerBanner: HoleCardsBannerKind = null;
  let oppBanner: HoleCardsBannerKind = null;
  const settlementOutcome = settlementOutcomeOverride ?? sp.settlementOutcome;
  const timeoutOrForfeitOutcome = settlementOutcome != null
    && (
      settlementOutcome === 'timed_out_waiting_for_our_move'
      || settlementOutcome === 'opponent_timed_out'
      || isSpacepokerTimeoutOrForfeit(settlementOutcome)
    )
    ? settlementOutcome
    : null;
  const oursTimeoutBadge = timeoutOrForfeitOutcome
    ? spacepokerTerminalBadge(timeoutOrForfeitOutcome, 'ours')
    : null;
  const theirsTimeoutBadge = timeoutOrForfeitOutcome
    ? spacepokerTerminalBadge(timeoutOrForfeitOutcome, 'theirs')
    : null;
  if (hasShowdownOutcome && (finished || handler === SpHandler.End)) {
    if (showdownOutcome.result > 0n) {
      playerBanner = 'win';
    } else if (showdownOutcome.result < 0n) {
      oppBanner = 'win';
    } else {
      playerBanner = 'tie';
      oppBanner = 'tie';
    }
  } else if (oursTimeoutBadge === 'timeout' || oursTimeoutBadge === 'forfeit') {
    playerBanner = oursTimeoutBadge;
    if (theirsTimeoutBadge === 'winner') oppBanner = 'win';
  } else if (theirsTimeoutBadge === 'timeout' || theirsTimeoutBadge === 'forfeit') {
    oppBanner = theirsTimeoutBadge;
    if (oursTimeoutBadge === 'winner') playerBanner = 'win';
  } else if (sp.terminalState === 'conceded-by-you') {
    playerBanner = 'concede';
  } else if (sp.terminalState === 'conceded-by-opponent') {
    oppBanner = 'concede';
  } else if (sp.terminalState === 'folded-by-you') {
    playerBanner = 'fold';
  } else if (sp.terminalState === 'folded-by-opponent') {
    oppBanner = 'fold';
  }

  let turnLine = '';
  if (myTurn && inBetting && !(handler === SpHandler.BeginRound && N === 4n && sp.coinTossIOpen === false)) {
    turnLine =
      handler === SpHandler.MidRound && sp.lastRaise > 0n
        ? `Your turn, ${sp.formatBet(sp.lastRaise)} to call`
        : 'Your turn';
  } else if (myTurn && handler === SpHandler.BeginRound && N === 4n && sp.coinTossIOpen === false) {
    turnLine = 'Coin toss: opponent opens\u2026';
  } else if (!myTurn && inBetting) {
    turnLine = 'Waiting for opponent\u2026';
  }

  return (
    <div className='relative flex flex-col items-center gap-1.5 py-0 w-full max-w-lg mx-auto text-canvas-text'>
      <div className='absolute right-0 top-0 flex items-center gap-1 text-xs text-canvas-text'>
        {(['xch', 'mojos', 'units'] as SpacepokerDisplayMode[]).map((mode) => (
          <button
            key={mode}
            type='button'
            className={`rounded px-2 py-0.5 ${sp.displayMode === mode ? 'bg-canvas-solid text-canvas-bg' : 'border border-canvas-line text-canvas-text-contrast'}`}
            onClick={() => sp.setDisplayMode(mode)}
          >
            {mode === 'xch' ? 'XCH' : mode}
          </button>
        ))}
      </div>

      {/* Opponent name */}
      <AmountBadge>{oppName}{oppIndicator}</AmountBadge>

      {/* Opponent cards row with stack on left */}
      <div className='relative flex justify-center w-full'>
        <div className='absolute left-0 top-1/2 -translate-y-1/2'>
          <AmountBadge>{sp.formatBet(sp.opponentStack)}</AmountBadge>
        </div>
        <HoleCardsGroup boosted={sp.opponentHoleCards ? sp.opponentBoost ?? false : false} banner={oppBanner}>
          {sp.opponentHoleCards ? (
            sp.opponentHoleCards.map((c, i) => (
              <CardColumn key={i} topSel={showPrivateShowdown && sp.outcome?.opponentHandCards?.includes(c)}>
                <SpCard rankLabelText={rankLabel(c)} />
              </CardColumn>
            ))
          ) : (
            <>
              <CardColumn><SpCard faceDown /></CardColumn>
              <CardColumn><SpCard faceDown /></CardColumn>
            </>
          )}
        </HoleCardsGroup>
      </div>

      {/* Opponent hand description — reserved height */}
      <p className='text-xs text-canvas-text-contrast text-center min-h-4'>{oppHandDesc}</p>

      {/* Community cards row with pot on left */}
      <div className='relative flex justify-center w-full'>
        <div className='absolute left-0 top-1/2 -translate-y-1/2'>
          <AmountBadge>{sp.formatBet(sp.pot)}</AmountBadge>
        </div>
        <div className='flex gap-1.5 items-center'>
          {Array.from({ length: communitySlots }).map((_, i) => {
            const card = communityReversed[i];
            if (card != null) {
              return (
                <CardColumn
                  key={i}
                  topSel={showPrivateShowdown && sp.outcome?.opponentHandCards?.includes(card)}
                  bottomSel={showPrivateShowdown && sp.outcome?.playerHandCards?.includes(card)}
                >
                  <SpCard rankLabelText={rankLabel(card)} />
                </CardColumn>
              );
            }
            return (
              <CardColumn key={i}>
                <CardSlot />
              </CardColumn>
            );
          })}
        </div>
      </div>

      {/* Player hand description — reserved height */}
      <p className='text-xs text-canvas-text-contrast text-center min-h-4'>{playerHandDesc}</p>

      {/* Player cards row with stack on left */}
      <div className='relative flex justify-center w-full'>
        <div className='absolute left-0 top-1/2 -translate-y-1/2'>
          <AmountBadge>{sp.formatBet(sp.playerStack)}</AmountBadge>
        </div>
        <HoleCardsGroup boosted={sp.playerHoleCards ? sp.playerBoost : false} banner={playerBanner}>
          {sp.playerHoleCards ? (
            sp.playerHoleCards.map((c, i) => (
              <CardColumn key={i} bottomSel={showPrivateShowdown && sp.outcome?.playerHandCards?.includes(c)}>
                <SpCard rankLabelText={rankLabel(c)} />
              </CardColumn>
            ))
          ) : (
            <>
              <CardColumn><CardSlot /></CardColumn>
              <CardColumn><CardSlot /></CardColumn>
            </>
          )}
        </HoleCardsGroup>
      </div>

      {/* Player name */}
      <AmountBadge>{playerName}{playerIndicator}</AmountBadge>

      {settlementNote && (
        <p className='text-xs text-canvas-text-contrast text-center'>{settlementNote}</p>
      )}

      {!finished && (
        <>
          {/* Action bar */}
          <ActionBar
            handler={handler}
            myTurn={myTurn}
            round={String(N)}
            coinTossIOpen={sp.coinTossIOpen}
            lastRaiseUnits={String(sp.lastRaise)}
            maxRaiseUnits={String(maxRaise)}
            formatBet={sp.formatBet}
            handleCheck={sp.handleCheck}
            handleRaise={sp.handleRaise}
            handleCall={sp.handleCall}
            handleFold={sp.handleFold}
          />

          {/* Turn indicator */}
          <p className='text-sm text-canvas-text-contrast font-medium text-center min-h-5'>{turnLine}</p>
        </>
      )}

      {/* Hand history */}
      <HandHistoryPanel rows={historyRows} />
    </div>
  );
}
