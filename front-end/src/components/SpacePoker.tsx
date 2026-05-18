import { useState, useCallback } from 'react';
import { Observable } from 'rxjs';
import { WasmBlobWrapper } from '../hooks/WasmBlobWrapper';
import {
  useSpacepokerHand,
  SpHandler,
  SpHandEntry,
  SpOutcome,
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

const STREET_LABELS: Record<number, string> = {
  4: 'Pre-Flop',
  3: 'Flop',
  2: 'Turn',
  1: 'River',
};

function phaseLabel(handler: SpHandler, N: number): string {
  if (handler === SpHandler.CommitA || handler === SpHandler.CommitB) return 'Shuffling\u2026';
  if (handler === SpHandler.Showdown) return 'Showdown';
  if (handler === SpHandler.Folded) return 'Folded';
  if (handler === SpHandler.End) return 'Revealing\u2026';
  return STREET_LABELS[N] ?? 'Pre-Flop';
}

const SEL_BAR = 'w-full h-1 rounded-full';
const SEL_VIS = `${SEL_BAR} bg-canvas-text-contrast`;
const SEL_HIDDEN = `${SEL_BAR} bg-transparent`;

function SpCard({ rank, faceDown, boost }: {
  rank?: number;
  faceDown?: boolean;
  boost?: boolean;
}) {
  const base = 'inline-flex items-center justify-center rounded border text-lg font-bold select-none';
  const size = 'w-10 h-14 sm:w-12 sm:h-16';
  if (faceDown) {
    return (
      <div className={`${base} ${size} bg-canvas-solid border-canvas-line text-canvas-bg`}>
        ?
      </div>
    );
  }
  return (
    <div className={`${base} ${size} bg-canvas-bg border-canvas-line text-canvas-text-contrast relative`}>
      {rank != null ? rankLabel(rank) : ''}
      {boost && <span className='absolute top-0.5 right-0.5 text-[10px] leading-none text-yellow-400'>&#9733;</span>}
    </div>
  );
}

function CardSlot() {
  return (
    <div className='inline-flex items-center justify-center rounded border border-dashed border-canvas-line w-10 h-14 sm:w-12 sm:h-16 text-canvas-text opacity-30' />
  );
}

function entrySymbol(entry: SpHandEntry): string {
  if (entry.action === 'check') return '\u2705';
  if (entry.action === 'call') return '\u270B';
  if (entry.action === 'fold') return '\u274C';
  return String(entry.units ?? '');
}

// Group history entries into rows pairing one action from each player.
// Within a single betting round, actions alternate between players, so
// consecutive pairs form one complete exchange. If a row's first entry
// is "you", the partner (if present) is the opponent's response, and
// vice versa.
interface HistoryRow {
  you: SpHandEntry | null;
  opponent: SpHandEntry | null;
}

function buildHistoryRows(history: SpHandEntry[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  let current: HistoryRow | null = null;
  for (const entry of history) {
    const slot: keyof HistoryRow = entry.player === 'you' ? 'you' : 'opponent';
    if (!current || current[slot] != null) {
      current = { you: null, opponent: null };
      rows.push(current);
    }
    current[slot] = entry;
  }
  return rows;
}

function HandHistoryPanel({ history }: { history: SpHandEntry[] }) {
  if (history.length === 0) return null;
  const rows = buildHistoryRows(history);
  return (
    <div className='w-full max-w-xs mx-auto'>
      <table className='w-full text-xs'>
        <thead>
          <tr className='text-canvas-text'>
            <th className='text-left font-medium px-1'>You</th>
            <th className='text-right font-medium px-1'>Opponent</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className='border-t border-canvas-line'>
              <td className='px-1 py-0.5 text-canvas-text-contrast'>
                {row.you ? entrySymbol(row.you) : ''}
              </td>
              <td className='px-1 py-0.5 text-canvas-text-contrast text-right'>
                {row.opponent ? entrySymbol(row.opponent) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActionBar({ sp }: { sp: UseSpacepokerHandResult }) {
  const [raiseAmount, setRaiseAmount] = useState(1);
  const { handler, myTurn, N } = sp.gameState;
  const inBetting = handler === SpHandler.BeginRound || handler === SpHandler.MidRound;
  const maxRaise = sp.playerStack - (sp.lastRaise > 0 ? sp.lastRaise : 0);
  const isBeginRound = handler === SpHandler.BeginRound;
  const autoPong = isBeginRound && N === 4 && sp.coinTossIOpen === false;

  const doRaise = useCallback(() => {
    if (raiseAmount < 1 || raiseAmount > maxRaise) return;
    sp.handleRaise(raiseAmount);
  }, [raiseAmount, maxRaise, sp]);

  if (!myTurn || !inBetting || autoPong) return null;

  return (
    <div className='flex flex-wrap items-center gap-2'>
      {isBeginRound && (
        <button
          onClick={sp.handleCheck}
          className='px-3 py-1.5 rounded bg-canvas-solid text-canvas-bg text-sm font-medium hover:opacity-90'
        >
          Check
        </button>
      )}
      {!isBeginRound && (
        <button
          onClick={sp.handleCall}
          className='px-3 py-1.5 rounded bg-green-600 text-white text-sm font-medium hover:opacity-90'
        >
          Call
        </button>
      )}
      <div className='flex items-center gap-1'>
        <button
          onClick={doRaise}
          disabled={maxRaise < 1}
          className='px-3 py-1.5 rounded bg-blue-600 text-white text-sm font-medium hover:opacity-90 disabled:opacity-40'
        >
          Raise
        </button>
        <input
          type='range'
          min={1}
          max={Math.max(1, maxRaise)}
          value={Math.min(raiseAmount, Math.max(1, maxRaise))}
          onChange={(e) => setRaiseAmount(parseInt(e.target.value))}
          className='w-20 sm:w-32'
        />
        <span className='text-xs text-canvas-text-contrast w-6 text-center'>{raiseAmount}</span>
      </div>
      <button
        onClick={sp.handleFold}
        className='px-3 py-1.5 rounded bg-red-600 text-white text-sm font-medium hover:opacity-90'
      >
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
  const isSetup = handler === SpHandler.CommitA || handler === SpHandler.CommitB;

  const showdownResult = sp.outcome
    ? sp.outcome.result > 0
      ? `${playerName} wins!`
      : sp.outcome.result < 0
        ? `${oppName} wins!`
        : 'Tie!'
    : '';

  return (
    <div className='flex flex-col items-center gap-3 py-4 w-full max-w-lg mx-auto text-canvas-text'>
      {/* Status bar */}
      <div className='flex w-full items-center justify-between text-sm'>
        <div className='flex flex-col items-start'>
          <span className='text-xs text-canvas-text'>{playerName}</span>
          <span className='font-semibold text-canvas-text-contrast'>{sp.playerStack} units</span>
        </div>
        <div className='flex flex-col items-center'>
          <span className='text-xs text-canvas-text'>Pot</span>
          <span className='font-bold text-lg text-canvas-text-contrast'>{sp.pot}</span>
          <span className='text-xs text-canvas-text'>{phaseLabel(handler, N)}</span>
        </div>
        <div className='flex flex-col items-end'>
          <span className='text-xs text-canvas-text'>{oppName}</span>
          <span className='font-semibold text-canvas-text-contrast'>{sp.opponentStack} units</span>
        </div>
      </div>

      {/* Opponent hole cards */}
      <div className='flex gap-2 items-center'>
        <span className='text-xs text-canvas-text mr-1'>{oppName}</span>
        {sp.opponentHoleCards ? (
          <>
            {sp.opponentHoleCards.map((c, i) => (
              <div key={i} className='flex flex-col items-center gap-0.5'>
                <div className={sp.outcome?.opponentHandCards?.includes(c) ? SEL_VIS : SEL_HIDDEN} />
                <SpCard rank={c} boost={sp.opponentBoost ?? false} />
              </div>
            ))}
          </>
        ) : (
          <>
            <SpCard faceDown />
            <SpCard faceDown />
          </>
        )}
      </div>

      {/* Opponent hand description at showdown */}
      {sp.outcome && sp.outcome.opponentHandEval && sp.outcome.opponentHandEval.length > 0 && (
        <p className='text-xs text-canvas-text-contrast'>{describeHand(sp.outcome.opponentHandEval)}</p>
      )}

      {/* Community cards */}
      <div className='flex gap-1.5 items-center py-2'>
        {Array.from({ length: communitySlots }).map((_, i) => {
          const card = communityReversed[i];
          if (card != null) {
            const inOpp = sp.outcome?.opponentHandCards?.includes(card);
            const inPlayer = sp.outcome?.playerHandCards?.includes(card);
            return (
              <div key={i} className='flex flex-col items-center gap-0.5'>
                <div className={inOpp ? SEL_VIS : SEL_HIDDEN} />
                <SpCard rank={card} />
                <div className={inPlayer ? SEL_VIS : SEL_HIDDEN} />
              </div>
            );
          }
          return <CardSlot key={i} />;
        })}
      </div>

      {/* Player hand description at showdown */}
      {sp.outcome && sp.outcome.playerHandEval && sp.outcome.playerHandEval.length > 0 && (
        <p className='text-xs text-canvas-text-contrast'>{describeHand(sp.outcome.playerHandEval)}</p>
      )}

      {/* Player hole cards */}
      <div className='flex gap-2 items-center'>
        <span className='text-xs text-canvas-text mr-1'>{playerName}</span>
        {sp.playerHoleCards ? (
          <>
            {sp.playerHoleCards.map((c, i) => (
              <div key={i} className='flex flex-col items-center gap-0.5'>
                <SpCard rank={c} boost={sp.playerBoost} />
                <div className={sp.outcome?.playerHandCards?.includes(c) ? SEL_VIS : SEL_HIDDEN} />
              </div>
            ))}
          </>
        ) : (
          <>
            <CardSlot />
            <CardSlot />
          </>
        )}
      </div>

      {/* Showdown result */}
      {handler === SpHandler.Showdown && showdownResult && (
        <p className='text-base font-bold text-canvas-text-contrast'>{showdownResult}</p>
      )}
      {handler === SpHandler.Folded && (
        <p className='text-base font-bold text-canvas-text-contrast'>Hand folded</p>
      )}

      {/* Action bar */}
      <ActionBar sp={sp} />

      {/* Turn indicator */}
      {myTurn && inBetting && !(handler === SpHandler.BeginRound && N === 4 && sp.coinTossIOpen === false) && (
        <p className='text-sm text-canvas-text-contrast font-medium'>Your turn</p>
      )}
      {myTurn && handler === SpHandler.BeginRound && N === 4 && sp.coinTossIOpen === false && (
        <p className='text-sm text-canvas-text'>{'Coin toss: opponent opens\u2026'}</p>
      )}
      {!myTurn && inBetting && (
        <p className='text-sm text-canvas-text'>{'Waiting for opponent\u2026'}</p>
      )}

      {/* Hand history */}
      <HandHistoryPanel history={sp.handHistory} />
    </div>
  );
}
