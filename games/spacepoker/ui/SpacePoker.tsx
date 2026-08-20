import { useCallback, useEffect, useRef, useState } from 'react';
import { Observable } from 'rxjs';
import {
  requireLiveGameHandSource,
  type GameHandSource,
} from '../../host';
import type { GameTerminalModel, GameplayEvent } from '../../host';
import { useCheatNerfKeys, useGameHost, useInitialGameHandState } from '../../host/ui';
import { describeSpacePokerHand, formatSpacepokerHandLog } from './handPresentation';
import { SpacePokerActionControls } from './SpacePokerActionControls';
import { SpacePokerHandHistory, SpacePokerTable } from './SpacePokerTable';
import {
  spacePokerFooterStatus,
  spacePokerTerminalBanners,
  spacePokerTerminalCommentary,
  spacePokerTerminalIndicators,
  spacePokerTurnLine,
} from './statusPresentation';
import {
  SpHandler,
  type SpacepokerDisplayMode,
  type SpacepokerHandState,
  useSpacepokerHand,
} from './useSpacepokerHand';

export interface SpacePokerProps {
  handSource: GameHandSource;
  gameId: string;
  iStarted: boolean;
  gameplayEvent$: Observable<GameplayEvent>;
  betSize: string;
  unitSizeMojos: string;
  onTurnChanged: (isMyTurn: boolean) => void;
  onGameLog: (lines: string[]) => void;
  myName?: string;
  opponentName?: string;
  terminal: GameTerminalModel;
}

export default function SpacePoker({
  handSource,
  gameId,
  iStarted,
  gameplayEvent$,
  betSize,
  unitSizeMojos,
  onTurnChanged,
  onGameLog,
  myName,
  opponentName,
  terminal,
}: SpacePokerProps) {
  const interactive = handSource.interactionMode === 'live';
  const betSizeValue = BigInt(betSize);
  const unitSizeMojosValue = BigInt(unitSizeMojos);
  const initialPersistedState = useInitialGameHandState(handSource);
  const sp = useSpacepokerHand(
    handSource,
    gameId,
    iStarted,
    gameplayEvent$,
    betSizeValue,
    unitSizeMojosValue,
    onTurnChanged,
    terminal,
    initialPersistedState ?? undefined,
  );
  const { handler, myTurn, N } = sp.gameState;
  const { currencyLabels: spCurrency, formatAmount } = useGameHost();

  const handleNerf = useCallback(() => {
    requireLiveGameHandSource(handSource).nerf();
  }, [handSource]);
  useCheatNerfKeys(sp.handleCheat, handleNerf, interactive);

  const [alreadyTerminalAtMount] = useState(() => {
    const handState = initialPersistedState;
    if (!handState || handState.gameType !== 'spacepoker') return false;
    const state = handState.state as SpacepokerHandState | undefined;
    return state?.terminalState != null && state.terminalState !== 'none';
  });
  const gameLogFiredRef = useRef(alreadyTerminalAtMount);
  useEffect(() => {
    if (sp.terminalState === 'none' || gameLogFiredRef.current || !sp.playerHoleCards) return;
    gameLogFiredRef.current = true;
    const stackSize = sp.betUnit > 0n ? betSizeValue / sp.betUnit : 0n;
    onGameLog(
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
        formatAmount,
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
    formatAmount,
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
            {mode === 'xch' ? spCurrency.xch : mode === 'mojos' ? spCurrency.mojos : mode}
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
        {sp.terminalRecovery && (
          <div className="flex flex-col items-center gap-1">
            <p className="text-sm text-alert-text">
              Final {sp.terminalRecovery} was not submitted.
            </p>
            <button
              type="button"
              className="px-3 py-1.5 rounded bg-primary-solid text-primary-on-primary text-sm font-medium hover:bg-primary-solid-hover disabled:opacity-40"
              disabled={!interactive}
              onClick={sp.retryTerminalAction}
            >
              Retry
            </button>
          </div>
        )}
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
