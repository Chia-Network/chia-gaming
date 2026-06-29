import { useState, useCallback, useEffect, type ReactNode } from 'react';
import { Observable } from 'rxjs';
import { WasmBlobWrapper } from '../hooks/WasmBlobWrapper';
import {
  useSpacepokerHand,
  SpHandler,
  SpHandEntry,
  SpacepokerDisplayMode,
} from '../hooks/useSpacepokerHand';
import { GameplayEvent } from '../hooks/useGameSession';
import { useCheatNerfKeys } from '../hooks/useCheatNerfKeys';

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

type HoleCardsBannerKind = 'fold' | 'concede' | 'win' | 'tie' | null;

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
              : 'bg-canvas-solid text-canvas-on-solid'
          }`}
        >
          {banner === 'win' ? 'Winner!' : banner === 'tie' ? 'Tie' : banner === 'concede' ? 'Concede' : 'Fold'}
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
  gameObject: WasmBlobWrapper;
  gameId: string;
  iStarted: boolean;
  gameplayEvent$: Observable<GameplayEvent>;
  betSize: string;
  unitSizeMojos?: string;
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
  unitSizeMojos,
  onTurnChanged,
  myName,
  opponentName,
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
  // hole cards.
  let playerBanner: HoleCardsBannerKind = null;
  let oppBanner: HoleCardsBannerKind = null;
  if (hasShowdownOutcome && (finished || handler === SpHandler.End)) {
    if (showdownOutcome.result > 0n) {
      playerBanner = 'win';
    } else if (showdownOutcome.result < 0n) {
      oppBanner = 'win';
    } else {
      playerBanner = 'tie';
      oppBanner = 'tie';
    }
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
