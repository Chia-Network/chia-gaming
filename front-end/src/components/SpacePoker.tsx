import { useState, useCallback, type ReactNode } from 'react';
import { Observable } from 'rxjs';
import { WasmBlobWrapper } from '../hooks/WasmBlobWrapper';
import {
  useSpacepokerHand,
  SpHandler,
  SpHandEntry,
  UseSpacepokerHandResult,
} from '../hooks/useSpacepokerHand';
import { GameplayEvent } from '../hooks/useGameSession';

const RANK_LABELS: Record<number, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

const FULL_RANKS: Record<number, string> = {
  2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven',
  8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace',
};

function rankLabel(rank: number): string {
  return RANK_LABELS[rank] ?? String(rank);
}

function fullRank(rank: number): string {
  return FULL_RANKS[rank] ?? String(rank);
}

function kickerSuffix(kickers: number[]): string {
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
function describeHand(eval_: number[]): string {
  if (!eval_ || eval_.length === 0) return '';
  const c0 = eval_[0];
  if (c0 === 5) {
    const b = eval_[1], r = eval_[2];
    return b ? `Five of a Kind, Boosted, ${fullRank(r)}s` : `Five of a Kind, ${fullRank(r)}s`;
  }
  if (c0 === 4 && eval_[1] === 1) {
    const b = eval_[2], r = eval_[3];
    return (b ? `Four of a Kind, Boosted, ${fullRank(r)}s` : `Four of a Kind, ${fullRank(r)}s`) + kickerSuffix([eval_[4]]);
  }
  if (c0 === 3 && eval_[1] === 3) {
    const b = eval_[2], r = eval_[3];
    return b ? `Straight, Boosted, ${fullRank(r)} high` : `Straight, ${fullRank(r)} high`;
  }
  if (c0 === 3 && eval_[1] === 2) {
    const b = eval_[2], s = eval_[3], p = eval_[4];
    return b
      ? `Full House, Boosted, ${fullRank(s)}s full of ${fullRank(p)}s`
      : `Full House, ${fullRank(s)}s full of ${fullRank(p)}s`;
  }
  if (c0 === 3 && eval_[1] === 1 && eval_[2] === 1) {
    const b = eval_[3], r = eval_[4];
    return (b ? `Three of a Kind, Boosted, ${fullRank(r)}s` : `Three of a Kind, ${fullRank(r)}s`) + kickerSuffix(eval_.slice(5));
  }
  if (c0 === 2 && eval_[1] === 2 && eval_[2] === 1) {
    const b = eval_[3], hp = eval_[4], lp = eval_[5];
    return (b
      ? `Two Pair, Boosted, ${fullRank(hp)}s and ${fullRank(lp)}s`
      : `Two Pair, ${fullRank(hp)}s and ${fullRank(lp)}s`) + kickerSuffix([eval_[6]]);
  }
  if (c0 === 2 && eval_[1] === 1 && eval_[2] === 1 && eval_[3] === 1) {
    const b = eval_[4], r = eval_[5];
    return (b ? `Pair, Boosted, ${fullRank(r)}s` : `Pair of ${fullRank(r)}s`) + kickerSuffix(eval_.slice(6));
  }
  if (c0 === 1 && eval_[1] === 1 && eval_[2] === 1 && eval_[3] === 1 && eval_[4] === 1) {
    const b = eval_[5], r = eval_[6];
    return (b ? `Boosted, ${fullRank(r)} high` : `${fullRank(r)} high`) + kickerSuffix(eval_.slice(7));
  }
  return eval_.join(' ');
}

const SEL_BAR = 'w-full h-1 rounded-full';
const SEL_VIS = `${SEL_BAR} bg-canvas-text-contrast`;
const SEL_HIDDEN = `${SEL_BAR} bg-transparent`;

function SpCard({ rank, faceDown }: { rank?: number; faceDown?: boolean }) {
  const base = 'inline-flex items-center justify-center rounded border text-lg font-bold select-none';
  const size = 'w-10 h-14 sm:w-12 sm:h-16';
  if (faceDown) {
    return (
      <div className={`${base} ${size} bg-canvas-solid border-canvas-line text-canvas-bg`}>?</div>
    );
  }
  return (
    <div className={`${base} ${size} bg-canvas-bg border-2 border-canvas-text-contrast text-canvas-text-contrast`}>
      {rank != null ? rankLabel(rank) : ''}
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

function HoleCardsGroup({ boosted, children }: { boosted?: boolean; children: ReactNode }) {
  return (
    <div className='relative inline-flex items-center'>
      <div className='flex gap-2 items-center'>{children}</div>
      {boosted && (
        <span className='absolute left-full top-1/2 -translate-y-1/2 ml-1 text-2xl font-bold text-canvas-text-contrast leading-none'>
          +
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

function entrySymbol(entry: SpHandEntry): string {
  if (entry.action === 'check') return '\u2705';
  if (entry.action === 'call') return '\u270B';
  if (entry.action === 'fold') return '\u274C';
  return String(entry.units ?? '');
}

function buildHistoryRows(history: SpHandEntry[]): [SpHandEntry | null, SpHandEntry | null][] {
  if (history.length === 0) return [];
  const rows: [SpHandEntry | null, SpHandEntry | null][] = [];
  let i = 0;
  if (history[0].player === 'opponent') {
    rows.push([null, history[0]]);
    i = 1;
  }
  for (; i < history.length; i += 2) {
    rows.push([history[i], history[i + 1] ?? null]);
  }
  return rows;
}

function HandHistoryPanel({ history }: { history: SpHandEntry[] }) {
  if (history.length === 0) return null;
  const rows = buildHistoryRows(history);
  return (
    <table className='text-base mx-auto'>
      <tbody>
        {rows.map(([left, right], i) => (
          <tr key={i} className={i > 0 ? 'border-t border-canvas-line' : ''}>
            <td className='px-3 py-1 text-canvas-text-contrast text-center w-12'>
              {left ? entrySymbol(left) : ''}
            </td>
            <td className='px-3 py-1 text-canvas-text-contrast text-center w-12'>
              {right ? entrySymbol(right) : ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ActionBar({ sp }: { sp: UseSpacepokerHandResult }) {
  const [raiseAmount, setRaiseAmount] = useState(1n);
  const { handler, myTurn, N } = sp.gameState;
  const inBetting = handler === SpHandler.BeginRound || handler === SpHandler.MidRound;
  const maxRaise = sp.playerStack - (sp.lastRaise > 0n ? sp.lastRaise : 0n);
  const maxRaiseInput = Math.max(1, Number(maxRaise));
  const raiseAmountInput = Math.min(Number(raiseAmount), maxRaiseInput);
  const isBeginRound = handler === SpHandler.BeginRound;
  const autoPong = isBeginRound && N === 4 && sp.coinTossIOpen === false;
  const actionsEnabled = myTurn && inBetting && !autoPong;

  const doRaise = useCallback(() => {
    if (!actionsEnabled || raiseAmount < 1n || raiseAmount > maxRaise) return;
    sp.handleRaise(raiseAmount);
  }, [actionsEnabled, raiseAmount, maxRaise, sp]);

  const btnClass =
    'px-3 py-1.5 rounded bg-primary-solid text-primary-on-primary text-sm font-medium hover:bg-primary-solid-hover disabled:opacity-40';

  return (
    <div className='flex flex-wrap items-center justify-center gap-2'>
      {isBeginRound ? (
        <button onClick={sp.handleCheck} disabled={!actionsEnabled} className={`${btnClass} w-16`}>
          Check
        </button>
      ) : (
        <button onClick={sp.handleCall} disabled={!actionsEnabled} className={`${btnClass} w-16`}>
          {sp.lastRaise > 0n ? 'Call' : 'Check'}
        </button>
      )}
      <div className='flex items-center gap-1'>
        <button onClick={doRaise} disabled={!actionsEnabled || maxRaise < 1n} className={btnClass}>
          Raise
        </button>
        <input
          type='range'
          min={1}
          max={maxRaiseInput}
          value={raiseAmountInput}
          onChange={(e) => setRaiseAmount(BigInt(e.target.value))}
          disabled={!actionsEnabled}
          className='w-20 sm:w-32 disabled:opacity-40'
        />
        <span className='text-xs text-canvas-text-contrast w-6 text-center'>{String(raiseAmount)}</span>
      </div>
      <button onClick={sp.handleFold} disabled={!actionsEnabled || isBeginRound} className={btnClass}>
        Fold
      </button>
    </div>
  );
}

export interface SpacePokerProps {
  gameObject: WasmBlobWrapper;
  gameId: string;
  iStarted: boolean;
  gameplayEvent$: Observable<GameplayEvent>;
  betSize: bigint;
  onTurnChanged: (isMyTurn: boolean) => void;
  myName?: string;
  opponentName?: string;
}

export default function SpacePoker({
  gameObject,
  gameId,
  iStarted,
  gameplayEvent$,
  betSize,
  onTurnChanged,
  myName,
  opponentName,
}: SpacePokerProps) {
  const sp = useSpacepokerHand(gameObject, gameId, iStarted, gameplayEvent$, betSize, onTurnChanged);
  const { handler, myTurn, N } = sp.gameState;

  const communitySlots = 5;
  const communityReversed = [...sp.communityCards];

  const playerName = myName ?? 'You';
  const oppName = opponentName ?? 'Opponent';

  const inBetting = handler === SpHandler.BeginRound || handler === SpHandler.MidRound;

  const oppHandDesc =
    sp.outcome?.opponentHandEval && sp.outcome.opponentHandEval.length > 0
      ? describeHand(sp.outcome.opponentHandEval)
      : '';
  const playerHandDesc =
    sp.outcome?.playerHandEval && sp.outcome.playerHandEval.length > 0
      ? describeHand(sp.outcome.playerHandEval)
      : '';

  const finished = handler === SpHandler.Showdown || handler === SpHandler.Folded;
  let playerIndicator = '';
  let oppIndicator = '';
  if (finished && sp.outcome) {
    playerIndicator = sp.outcome.result > 0 ? ' \u2705' : sp.outcome.result < 0 ? ' \u274C' : '';
    oppIndicator = sp.outcome.result < 0 ? ' \u2705' : sp.outcome.result > 0 ? ' \u274C' : '';
  } else if (handler === SpHandler.Folded) {
    const lastEntry = sp.handHistory[sp.handHistory.length - 1];
    const youFolded = lastEntry?.player === 'you' && lastEntry?.action === 'fold';
    playerIndicator = youFolded ? ' \u274C' : ' \u2705';
    oppIndicator = youFolded ? ' \u2705' : ' \u274C';
  }

  let turnLine = '';
  if (myTurn && inBetting && !(handler === SpHandler.BeginRound && N === 4 && sp.coinTossIOpen === false)) {
    turnLine =
      handler === SpHandler.MidRound && sp.lastRaise > 0n
        ? `Your turn, ${sp.lastRaise} to call`
        : 'Your turn';
  } else if (myTurn && handler === SpHandler.BeginRound && N === 4 && sp.coinTossIOpen === false) {
    turnLine = 'Coin toss: opponent opens\u2026';
  } else if (!myTurn && inBetting) {
    turnLine = 'Waiting for opponent\u2026';
  }

  return (
    <div className='flex flex-col items-center gap-1.5 py-4 w-full max-w-lg mx-auto text-canvas-text'>
      {/* Opponent name */}
      <AmountBadge>{oppName}{oppIndicator}</AmountBadge>

      {/* Opponent cards row with stack on left */}
      <div className='relative flex justify-center w-full'>
        <div className='absolute left-0 top-1/2 -translate-y-1/2'>
          <AmountBadge>{String(sp.opponentStack)}</AmountBadge>
        </div>
        <HoleCardsGroup boosted={sp.opponentHoleCards ? sp.opponentBoost ?? false : false}>
          {sp.opponentHoleCards ? (
            sp.opponentHoleCards.map((c, i) => (
              <CardColumn key={i} topSel={sp.outcome?.opponentHandCards?.includes(c)}>
                <SpCard rank={c} />
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
          <AmountBadge>{String(sp.pot)}</AmountBadge>
        </div>
        <div className='flex gap-1.5 items-center'>
          {Array.from({ length: communitySlots }).map((_, i) => {
            const card = communityReversed[i];
            if (card != null) {
              return (
                <CardColumn
                  key={i}
                  topSel={sp.outcome?.opponentHandCards?.includes(card)}
                  bottomSel={sp.outcome?.playerHandCards?.includes(card)}
                >
                  <SpCard rank={card} />
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
          <AmountBadge>{String(sp.playerStack)}</AmountBadge>
        </div>
        <HoleCardsGroup boosted={sp.playerHoleCards ? sp.playerBoost : false}>
          {sp.playerHoleCards ? (
            sp.playerHoleCards.map((c, i) => (
              <CardColumn key={i} bottomSel={sp.outcome?.playerHandCards?.includes(c)}>
                <SpCard rank={c} />
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

      {/* Action bar */}
      <ActionBar sp={sp} />

      {/* Turn indicator — reserved height */}
      <p className='text-sm text-canvas-text-contrast font-medium text-center min-h-5'>{turnLine}</p>

      {/* Hand history */}
      <HandHistoryPanel history={sp.handHistory} />
    </div>
  );
}
