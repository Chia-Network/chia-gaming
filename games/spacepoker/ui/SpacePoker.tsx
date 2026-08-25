import { useEffect, useRef, useState } from 'react';
import { gameHandState, type GameHandSource } from '../../host';
import { describeSpacePokerHand, formatSpacepokerHandLog } from './handPresentation';
import { formatSpacepokerAmount } from './formatting';
import { SpacePokerActionControls } from './SpacePokerActionControls';
import { SpacePokerHandHistory, SpacePokerTable } from './SpacePokerTable';
import {
  spacePokerFooterStatus,
  spacePokerTerminalBanners,
  spacePokerTerminalCommentary,
  spacePokerTerminalIndicators,
  spacePokerTurnLine,
} from './statusPresentation';
import { SpHandler, type SpacepokerDisplayMode, useSpacepokerHand } from './useSpacepokerHand';
import type { SpacepokerHandState } from './serialize';

export interface SpacePokerProps {
  handSource: GameHandSource<SpacepokerHandState>;
  onGameLog?: (lines: string[]) => void;
  myName?: string;
  opponentName?: string;
}

export function advanceSpacepokerCheatSequence(
  current: string,
  key: string,
): { buffer: string; triggered: boolean } {
  const sequence = 'cheat^';
  const next = current + key;
  if (next === sequence) return { buffer: '', triggered: true };
  if (sequence.startsWith(next)) return { buffer: next, triggered: false };
  return { buffer: sequence.startsWith(key) ? key : '', triggered: false };
}

function useSpacepokerCheatKeys(handleCheat: () => void, enabled: boolean): void {
  const buffer = useRef('');
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        return;
      if (event.key.length !== 1) return;
      const next = advanceSpacepokerCheatSequence(buffer.current, event.key);
      buffer.current = next.buffer;
      if (next.triggered) handleCheat();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, handleCheat]);
}

export default function SpacePoker({
  handSource,
  onGameLog,
  myName,
  opponentName,
}: SpacePokerProps) {
  const interactive = handSource.interactionMode === 'live';
  const state = gameHandState(handSource);
  const betSizeValue = state.perPlayerStake * 2n;
  const sp = useSpacepokerHand(handSource);
  const { handler, myTurn, N } = sp.gameState;
  useSpacepokerCheatKeys(sp.handleCheat, interactive);

  const [alreadyTerminalAtMount] = useState(() => {
    const state = gameHandState(handSource);
    return state.terminalState !== 'none';
  });
  const gameLogFiredRef = useRef(alreadyTerminalAtMount);
  useEffect(() => {
    if (sp.terminalState === 'none' || gameLogFiredRef.current || !sp.playerHoleCards) return;
    gameLogFiredRef.current = true;
    const stackSize = sp.betUnit > 0n ? betSizeValue / 2n / sp.betUnit : 0n;
    onGameLog?.(
      formatSpacepokerHandLog(
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
        formatSpacepokerAmount,
      ),
    );
  }, [
    sp.terminalState,
    sp.playerHoleCards,
    sp.playerBoost,
    sp.opponentHoleCards,
    sp.opponentBoost,
    sp.communityCards,
    sp.handHistory,
    sp.outcome,
    sp.coinTossIOpen,
    sp.betUnit,
    betSizeValue,
    onGameLog,
  ]);

  const inBetting = handler === SpHandler.BeginRound || handler === SpHandler.MidRound;
  const maxRaise = sp.playerStack - (sp.lastRaise > 0n ? sp.lastRaise : 0n);
  const forcedAuto = inBetting && sp.lastRaise === 0n && sp.playerStack <= 0n;
  const showdownOutcome = sp.outcome;
  const showPrivateShowdown = sp.terminalState === 'revealed' || showdownOutcome !== null;
  const finished = handler === SpHandler.Showdown || handler === SpHandler.Folded;
  const visibleShowdownResult =
    showdownOutcome && (finished || handler === SpHandler.End) ? showdownOutcome.result : null;

  const opponentHandDescription =
    showPrivateShowdown &&
    showdownOutcome?.opponentHandEval &&
    showdownOutcome.opponentHandEval.length > 0
      ? describeSpacePokerHand(showdownOutcome.opponentHandEval)
      : '';
  const playerHandDescription =
    showPrivateShowdown &&
    showdownOutcome?.playerHandEval &&
    showdownOutcome.playerHandEval.length > 0
      ? describeSpacePokerHand(showdownOutcome.playerHandEval)
      : '';
  const banners = spacePokerTerminalBanners(sp.terminalState, visibleShowdownResult);
  const indicators = spacePokerTerminalIndicators(sp.terminalState, visibleShowdownResult);
  const turnLine = spacePokerTurnLine(
    handler,
    myTurn,
    N,
    sp.coinTossIOpen,
    sp.lastRaise,
    sp.formatBet,
  );
  const terminalCommentary = spacePokerTerminalCommentary(
    sp.terminalState,
    showdownOutcome?.result ?? null,
    sp.terminalOutcome,
  );
  const footerStatus =
    terminalCommentary || spacePokerFooterStatus(handler, turnLine) || 'Updating hand…';

  return (
    <div className="relative flex flex-col items-center gap-1.5 py-0 w-full max-w-lg mx-auto text-canvas-text">
      <div className="absolute right-0 top-0 flex items-center gap-1 text-xs text-canvas-text">
        {(['xch', 'mojos', 'units'] as SpacepokerDisplayMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            className={`rounded px-2 py-0.5 ${sp.displayMode === mode ? 'bg-canvas-solid text-canvas-bg' : 'border border-canvas-line text-canvas-text-contrast'}`}
            onClick={() => sp.setDisplayMode(mode)}
          >
            {mode === 'xch' ? 'XCH' : mode}
          </button>
        ))}
      </div>

      <SpacePokerTable
        opponentName={opponentName ?? 'Opponent'}
        playerName={myName ?? 'You'}
        opponentIndicator={indicators.opponent}
        playerIndicator={indicators.player}
        opponentStack={sp.opponentStack}
        playerStack={sp.playerStack}
        pot={sp.pot}
        opponentHoleCards={sp.opponentHoleCards}
        playerHoleCards={sp.playerHoleCards}
        opponentBoost={sp.opponentBoost}
        playerBoost={sp.playerBoost}
        communityCards={sp.communityCards}
        opponentHandDescription={opponentHandDescription}
        playerHandDescription={playerHandDescription}
        opponentBanner={banners.opponent}
        playerBanner={banners.player}
        outcome={showdownOutcome}
        showPrivateShowdown={showPrivateShowdown}
        formatBet={sp.formatBet}
      />

      <div className="flex min-h-[4.5rem] flex-col justify-center gap-2">
        <SpacePokerActionControls
          interactive={interactive}
          handler={handler}
          myTurn={myTurn}
          round={String(N)}
          coinTossIOpen={sp.coinTossIOpen}
          lastRaiseUnits={String(sp.lastRaise)}
          maxRaiseUnits={String(maxRaise)}
          forcedAuto={forcedAuto}
          formatBet={sp.formatBet}
          handleCheck={sp.handleCheck}
          handleRaise={sp.handleRaise}
          handleCall={sp.handleCall}
          handleFold={sp.handleFold}
        />
        <p className="text-sm text-canvas-text-contrast font-medium text-center min-h-5">
          {footerStatus}
        </p>
      </div>

      <SpacePokerHandHistory history={sp.handHistory} formatBet={sp.formatBet} />
    </div>
  );
}
