import type { ReactNode } from 'react';
import { spacePokerRankLabel } from './handPresentation';
import type { HoleCardsBannerKind } from './statusPresentation';
import type { SpHandEntry, SpOutcome } from './useSpacepokerHand';

const SEL_BAR = 'w-full h-1 rounded-full';
const SEL_VIS = `${SEL_BAR} bg-canvas-text-contrast`;
const SEL_HIDDEN = `${SEL_BAR} bg-transparent`;

function SpacePokerCard({
  rankLabelText,
  faceDown,
}: {
  rankLabelText?: string;
  faceDown?: boolean;
}) {
  const base = 'inline-flex items-center justify-center rounded border font-bold select-none';
  const size = 'w-10 h-14 sm:w-12 sm:h-16';
  if (faceDown) {
    return (
      <div
        className={`${base} ${size} bg-canvas-solid border-canvas-line text-canvas-bg text-4xl leading-none`}
      >
        ?
      </div>
    );
  }
  return (
    <div
      className={`${base} ${size} bg-canvas-bg border-2 border-canvas-text-contrast text-canvas-text-contrast`}
    >
      <svg
        aria-label={rankLabelText ?? ''}
        className="h-[90%] w-[90%] overflow-visible"
        role="img"
        viewBox="0 0 100 100"
      >
        <text
          className="fill-current"
          dominantBaseline="central"
          fontSize="108"
          fontWeight="700"
          style={{
            fontFamily:
              'Cheltenham, "ITC Cheltenham", "Cheltenham Std", "Times New Roman", Times, serif',
          }}
          textAnchor="middle"
          x="50"
          y="50"
        >
          {rankLabelText ?? ''}
        </text>
      </svg>
    </div>
  );
}

function CardSlot() {
  return (
    <div className="inline-flex items-center justify-center rounded border border-dashed border-canvas-line w-10 h-14 sm:w-12 sm:h-16 text-canvas-text opacity-30" />
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
    <div className="flex flex-col items-center gap-0.5">
      <div className={topSel ? SEL_VIS : SEL_HIDDEN} />
      {children}
      <div className={bottomSel ? SEL_VIS : SEL_HIDDEN} />
    </div>
  );
}

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
    <div className="relative inline-flex items-center">
      <div className="flex gap-2 items-center">{children}</div>
      {boosted && (
        <span className="absolute left-full top-1/2 -translate-y-1/2 ml-1 text-2xl font-bold text-canvas-text-contrast leading-none">
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
                : 'Fold'}
        </span>
      )}
    </div>
  );
}

function AmountBadge({ children }: { children: ReactNode }) {
  return (
    <span className="font-bold text-lg text-canvas-text-contrast tabular-nums">{children}</span>
  );
}

function entrySymbol(entry: SpHandEntry, formatBet: (units: bigint) => string): string {
  if (entry.action === 'check') return entry.endsStreet ? '\u270B' : '\u2705';
  if (entry.action === 'call') return '\u270B';
  if (entry.action === 'fold' || entry.action === 'failed') return '\u274C';
  if (entry.action === 'concede') return '\u{1F3F3}\uFE0F';
  if (entry.action === 'reveal') return '\u{1F440}';
  return formatBet(entry.units ?? 0n);
}

function buildHistoryRows(
  history: SpHandEntry[],
  formatBet: (units: bigint) => string,
): [string | null, string | null][] {
  if (history.length === 0) return [];
  const rows: [string | null, string | null][] = [];
  let index = 0;
  if (history[0].player === 'opponent') {
    rows.push([null, entrySymbol(history[0], formatBet)]);
    index = 1;
  }
  for (; index < history.length; index += 2) {
    rows.push([
      entrySymbol(history[index], formatBet),
      history[index + 1] ? entrySymbol(history[index + 1], formatBet) : null,
    ]);
  }
  return rows;
}

export function SpacePokerHandHistory({
  history,
  formatBet,
}: {
  history: SpHandEntry[];
  formatBet: (units: bigint) => string;
}) {
  const rows = buildHistoryRows(history, formatBet);
  if (rows.length === 0) return null;
  return (
    <table className="text-base mx-auto table-auto">
      <tbody>
        {rows.map(([left, right], index) => (
          <tr key={index} className={index > 0 ? 'border-t border-canvas-line' : ''}>
            <td className="px-3 py-1 text-canvas-text-contrast text-center min-w-12 whitespace-nowrap tabular-nums">
              {left ?? ''}
            </td>
            <td className="px-3 py-1 text-canvas-text-contrast text-center min-w-12 whitespace-nowrap tabular-nums">
              {right ?? ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface SpacePokerTableProps {
  opponentName: string;
  playerName: string;
  opponentIndicator: string;
  playerIndicator: string;
  opponentStack: bigint;
  playerStack: bigint;
  pot: bigint;
  opponentHoleCards: [bigint, bigint] | null;
  playerHoleCards: [bigint, bigint] | null;
  opponentBoost: boolean | null;
  playerBoost: boolean;
  communityCards: (bigint | null)[];
  opponentHandDescription: string;
  playerHandDescription: string;
  opponentBanner: HoleCardsBannerKind;
  playerBanner: HoleCardsBannerKind;
  outcome: SpOutcome | null;
  showPrivateShowdown: boolean;
  formatBet: (units: bigint) => string;
}

export function SpacePokerTable({
  opponentName,
  playerName,
  opponentIndicator,
  playerIndicator,
  opponentStack,
  playerStack,
  pot,
  opponentHoleCards,
  playerHoleCards,
  opponentBoost,
  playerBoost,
  communityCards,
  opponentHandDescription,
  playerHandDescription,
  opponentBanner,
  playerBanner,
  outcome,
  showPrivateShowdown,
  formatBet,
}: SpacePokerTableProps) {
  return (
    <>
      <AmountBadge>
        {opponentName}
        {opponentIndicator}
      </AmountBadge>

      <div className="relative flex justify-center w-full">
        <div className="absolute left-0 top-1/2 -translate-y-1/2">
          <AmountBadge>{formatBet(opponentStack)}</AmountBadge>
        </div>
        <HoleCardsGroup
          boosted={opponentHoleCards ? (opponentBoost ?? false) : false}
          banner={opponentBanner}
        >
          {opponentHoleCards ? (
            opponentHoleCards.map((card, index) => (
              <CardColumn
                key={index}
                topSel={showPrivateShowdown && outcome?.opponentHandCards?.includes(card)}
              >
                <SpacePokerCard rankLabelText={spacePokerRankLabel(card)} />
              </CardColumn>
            ))
          ) : (
            <>
              <CardColumn>
                <SpacePokerCard faceDown />
              </CardColumn>
              <CardColumn>
                <SpacePokerCard faceDown />
              </CardColumn>
            </>
          )}
        </HoleCardsGroup>
      </div>

      <p className="text-xs text-canvas-text-contrast text-center min-h-4">
        {opponentHandDescription}
      </p>

      <div className="relative flex justify-center w-full">
        <div className="absolute left-0 top-1/2 -translate-y-1/2">
          <AmountBadge>{formatBet(pot)}</AmountBadge>
        </div>
        <div className="flex gap-1.5 items-center">
          {Array.from({ length: 5 }).map((_, index) => {
            const card = communityCards[index];
            if (card != null) {
              return (
                <CardColumn
                  key={index}
                  topSel={showPrivateShowdown && outcome?.opponentHandCards?.includes(card)}
                  bottomSel={showPrivateShowdown && outcome?.playerHandCards?.includes(card)}
                >
                  <SpacePokerCard rankLabelText={spacePokerRankLabel(card)} />
                </CardColumn>
              );
            }
            return (
              <CardColumn key={index}>
                <CardSlot />
              </CardColumn>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-canvas-text-contrast text-center min-h-4">
        {playerHandDescription}
      </p>

      <div className="relative flex justify-center w-full">
        <div className="absolute left-0 top-1/2 -translate-y-1/2">
          <AmountBadge>{formatBet(playerStack)}</AmountBadge>
        </div>
        <HoleCardsGroup boosted={playerHoleCards ? playerBoost : false} banner={playerBanner}>
          {playerHoleCards ? (
            playerHoleCards.map((card, index) => (
              <CardColumn
                key={index}
                bottomSel={showPrivateShowdown && outcome?.playerHandCards?.includes(card)}
              >
                <SpacePokerCard rankLabelText={spacePokerRankLabel(card)} />
              </CardColumn>
            ))
          ) : (
            <>
              <CardColumn>
                <CardSlot />
              </CardColumn>
              <CardColumn>
                <CardSlot />
              </CardColumn>
            </>
          )}
        </HoleCardsGroup>
      </div>

      <AmountBadge>
        {playerName}
        {playerIndicator}
      </AmountBadge>
    </>
  );
}
