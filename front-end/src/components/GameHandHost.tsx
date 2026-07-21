import { useCallback } from 'react';
import { EMPTY, type Observable } from 'rxjs';

import Calpoker from '../features/calPoker';
import { useCalpokerHand } from '../hooks/useCalpokerHand';
import type { CalpokerDisplaySnapshot } from '../hooks/save';
import type { SessionController } from '../hooks/SessionController';
import type { GameplayEvent } from '../hooks/useGameSession';
import type { SettlementOutcome } from '../lib/settlement';
import { gameDisplayName } from '../lib/gameRegistry';
import { stringifyCalpokerSnapshot } from '../lib/session/finishedSessionDisplay';
import type { HandTermsModel } from '../lib/session/model';
import type { CalpokerOutcome } from '../types/ChiaGaming';
import type {
  CalpokerDisplaySnapshotView,
  CalpokerOutcomeView,
} from '../types/californiaPoker/CaliforniapokerProps';
import { formatAmount } from '../util';
import Krunk from './Krunk';
import SpacePoker from './SpacePoker';

export type GameHandHostMode = 'live' | 'frozen';

export interface GameHandHostProps {
  mode: GameHandHostMode;
  gameType: string;
  /**
   * Live: real SessionController. Frozen: stub from createFrozenHandBridge.
   * Do not pass PersistedGameState (bigint arrays) as React props — React's
   * prop describe path JSON.stringifies arrays and throws on BigInt.
   */
  sessionController: SessionController;
  gameplayEvent$?: Observable<GameplayEvent>;
  gameId: string;
  currentHandGameIds?: string[];
  activeGameIds?: string[];
  iStarted: boolean;
  iProposedHand?: boolean;
  playerNumber: number;
  perGameAmount: bigint;
  lastHandTerms: HandTermsModel;
  myName?: string;
  opponentName?: string;
  /** Session-level settlement used when the hook has no live Settled event (frozen). */
  settlementOutcome?: SettlementOutcome | null;
  /** Per-game settlements for atomic games such as Krunk. */
  gameSettlementOutcomes?: Record<string, SettlementOutcome | null>;
  onOutcome?: (outcome: CalpokerOutcome) => void;
  onTurnChanged?: (gameId: string, isMyTurn: boolean) => void;
  appendGameLog?: (line: string) => void;
  handKey?: number;
}

function parseCalpokerSnapshotView(snapshot: CalpokerDisplaySnapshotView): CalpokerDisplaySnapshot {
  return {
    ...snapshot,
    playerBestHandCardIds: snapshot.playerBestHandCardIds.map(BigInt),
    opponentBestHandCardIds: snapshot.opponentBestHandCardIds.map(BigInt),
    playerHaloCardIds: snapshot.playerHaloCardIds.map(BigInt),
    opponentHaloCardIds: snapshot.opponentHaloCardIds.map(BigInt),
  };
}

function stringifyCalpokerOutcome(outcome: CalpokerOutcome | undefined): CalpokerOutcomeView | undefined {
  if (!outcome) return undefined;
  return {
    my_win_outcome: outcome.my_win_outcome,
    my_cards: outcome.my_cards.map(String),
    their_cards: outcome.their_cards.map(String),
    my_final_hand: outcome.my_final_hand.map(String),
    their_final_hand: outcome.their_final_hand.map(String),
    my_used_cards: outcome.my_used_cards.map(String),
    their_used_cards: outcome.their_used_cards.map(String),
    my_hand_value: outcome.my_hand_value.map(String),
    their_hand_value: outcome.their_hand_value.map(String),
  };
}

function CalpokerHand({
  gameObject,
  gameId,
  iStarted,
  playerNumber,
  gameplayEvent$,
  onOutcome,
  onTurnChanged,
  appendGameLog,
  perGameAmount,
  myName,
  opponentName,
  settlementOutcomeOverride,
}: {
  gameObject: SessionController;
  gameId: string;
  iStarted: boolean;
  playerNumber: number;
  gameplayEvent$: Observable<GameplayEvent>;
  onOutcome: (outcome: CalpokerOutcome) => void;
  onTurnChanged: (gameId: string, isMyTurn: boolean) => void;
  appendGameLog: (line: string) => void;
  perGameAmount: bigint;
  myName?: string;
  opponentName?: string;
  settlementOutcomeOverride?: SettlementOutcome | null;
}) {
  const handleTurnChanged = useCallback(
    (isMyTurn: boolean) => onTurnChanged(gameId, isMyTurn),
    [gameId, onTurnChanged],
  );
  const {
    playerHand,
    opponentHand,
    cardSelections,
    setCardSelections,
    setHandOrder,
    moveNumber,
    outcome,
    settlementOutcome,
    handleMakeMove,
    handleCheat,
    handleNerf,
    saveDisplaySnapshot,
    initialDisplaySnapshot,
  } = useCalpokerHand(
    gameObject,
    gameId,
    iStarted,
    gameplayEvent$,
    onOutcome,
    handleTurnChanged,
    gameObject.handState ?? undefined,
  );

  const handleGameLog = useCallback((lines: string[]) => {
    appendGameLog(`California Poker ${formatAmount(perGameAmount)}`);
    lines.forEach((l) => appendGameLog(l));
    appendGameLog('');
  }, [appendGameLog, perGameAmount]);

  const setUiCardSelections = useCallback((next: string[] | ((prev: string[]) => string[])) => {
    setCardSelections((prev) => {
      const prevView = prev.map(String);
      const nextView = typeof next === 'function' ? next(prevView) : next;
      return nextView.map(BigInt);
    });
  }, [setCardSelections]);

  const handleSnapshotChange = useCallback((snapshot: CalpokerDisplaySnapshotView) => {
    saveDisplaySnapshot(parseCalpokerSnapshotView(snapshot));
  }, [saveDisplaySnapshot]);

  const setUiHandOrder = useCallback((nextPlayerHand: string[], nextOpponentHand?: string[]) => {
    setHandOrder(nextPlayerHand.map(BigInt), nextOpponentHand?.map(BigInt));
  }, [setHandOrder]);

  return (
    <Calpoker
      outcome={stringifyCalpokerOutcome(outcome)}
      moveNumber={String(moveNumber)}
      playerNumber={playerNumber}
      playerHand={playerHand.map(String)}
      opponentHand={opponentHand.map(String)}
      cardSelections={cardSelections.map(String)}
      setCardSelections={setUiCardSelections}
      setHandOrder={setUiHandOrder}
      handleMakeMove={handleMakeMove}
      handleCheat={handleCheat}
      handleNerf={handleNerf}
      onGameLog={handleGameLog}
      onSnapshotChange={handleSnapshotChange}
      initialSnapshot={stringifyCalpokerSnapshot(initialDisplaySnapshot)}
      myName={myName}
      opponentName={opponentName}
      settlementOutcome={settlementOutcomeOverride ?? settlementOutcome}
    />
  );
}

function SpacePokerHand({
  gameObject,
  gameId,
  iStarted,
  gameplayEvent$,
  betSize,
  unitSizeMojos,
  onTurnChanged,
  appendGameLog,
  perGameAmount,
  myName,
  opponentName,
  settlementOutcomeOverride,
}: {
  gameObject: SessionController;
  gameId: string;
  iStarted: boolean;
  gameplayEvent$: Observable<GameplayEvent>;
  betSize: string;
  unitSizeMojos?: string;
  onTurnChanged: (gameId: string, isMyTurn: boolean) => void;
  appendGameLog: (line: string) => void;
  perGameAmount: bigint;
  myName?: string;
  opponentName?: string;
  settlementOutcomeOverride?: SettlementOutcome | null;
}) {
  const unitMojos = unitSizeMojos ? BigInt(unitSizeMojos) : 1n;
  const stackSize = unitMojos > 0n ? perGameAmount / unitMojos : 0n;
  const handleTurnChanged = useCallback(
    (isMyTurn: boolean) => onTurnChanged(gameId, isMyTurn),
    [gameId, onTurnChanged],
  );

  const handleGameLog = useCallback((lines: string[]) => {
    appendGameLog(`Space Poker ${stackSize} (${formatAmount(unitMojos)})`);
    lines.forEach((l) => appendGameLog(l));
    appendGameLog('');
  }, [appendGameLog, unitMojos, stackSize]);

  return (
    <SpacePoker
      gameObject={gameObject}
      gameId={gameId}
      iStarted={iStarted}
      gameplayEvent$={gameplayEvent$}
      betSize={betSize}
      unitSizeMojos={unitSizeMojos}
      onTurnChanged={handleTurnChanged}
      onGameLog={handleGameLog}
      myName={myName}
      opponentName={opponentName}
      settlementOutcome={settlementOutcomeOverride}
    />
  );
}

function KrunkHand({
  gameObject,
  currentHandGameIds,
  activeGameIds,
  iProposedHand,
  gameplayEvent$,
  betSize,
  onTurnChanged,
  appendGameLog,
  myName,
  opponentName,
  frozen,
  gameSettlementOutcomes,
}: {
  gameObject: SessionController;
  currentHandGameIds: string[];
  activeGameIds: string[];
  iProposedHand: boolean;
  gameplayEvent$: Observable<GameplayEvent>;
  betSize: bigint;
  onTurnChanged: (gameId: string, isMyTurn: boolean) => void;
  appendGameLog: (line: string) => void;
  myName?: string;
  opponentName?: string;
  frozen: boolean;
  gameSettlementOutcomes?: Record<string, SettlementOutcome | null>;
}) {
  const handleGameLog = useCallback((lines: string[]) => {
    lines.forEach((l) => appendGameLog(l));
    appendGameLog('');
  }, [appendGameLog]);

  return (
    <Krunk
      gameObject={gameObject}
      currentHandGameIds={currentHandGameIds}
      activeGameIds={activeGameIds}
      iProposedHand={iProposedHand}
      gameplayEvent$={gameplayEvent$}
      betSize={betSize}
      onTurnChanged={onTurnChanged}
      onGameLog={handleGameLog}
      myName={myName}
      opponentName={opponentName}
      frozen={frozen}
      gameSettlementOutcomes={gameSettlementOutcomes}
    />
  );
}

/**
 * Shared mount for live GameSession and post-resolve frozen remount.
 * Frozen mode uses a stub controller + empty event stream so the same
 * game components hydrate from controller.handState without WASM.
 */
export default function GameHandHost({
  mode,
  gameType,
  sessionController,
  gameplayEvent$,
  gameId,
  currentHandGameIds = [],
  activeGameIds = [],
  iStarted,
  iProposedHand = false,
  playerNumber,
  perGameAmount,
  lastHandTerms,
  myName,
  opponentName,
  settlementOutcome = null,
  gameSettlementOutcomes,
  onOutcome,
  onTurnChanged,
  appendGameLog,
  handKey = 0,
}: GameHandHostProps) {
  const gameObject = sessionController;
  const controllerHandState = gameObject.handState;
  const events$ = mode === 'frozen' ? EMPTY : (gameplayEvent$ ?? EMPTY);
  const noopTurn = useCallback((_gameId: string, _isMyTurn: boolean) => {}, []);
  const noopLog = useCallback((_line: string) => {}, []);
  const noopOutcome = useCallback((_outcome: CalpokerOutcome) => {}, []);
  const turnHandler = onTurnChanged ?? noopTurn;
  const logHandler = appendGameLog ?? noopLog;
  const outcomeHandler = onOutcome ?? noopOutcome;

  const spacepokerUnitSizeMojos = lastHandTerms.gameType === 'spacepoker' && lastHandTerms.spacepokerUnitSize
    ? String(lastHandTerms.spacepokerUnitSize)
    : controllerHandState?.gameType === 'spacepoker'
      ? String((controllerHandState.state as { unitSizeMojos?: bigint }).unitSizeMojos ?? 1n)
      : undefined;

  const content = (() => {
    if (gameType === 'calpoker') {
      return (
        <CalpokerHand
          key={handKey}
          gameObject={gameObject}
          gameId={gameId}
          iStarted={iStarted}
          playerNumber={playerNumber}
          gameplayEvent$={events$}
          onOutcome={outcomeHandler}
          onTurnChanged={turnHandler}
          appendGameLog={logHandler}
          perGameAmount={perGameAmount}
          myName={myName}
          opponentName={opponentName}
          settlementOutcomeOverride={settlementOutcome}
        />
      );
    }
    if (gameType === 'spacepoker') {
      return (
        <SpacePokerHand
          key={handKey}
          gameObject={gameObject}
          gameId={gameId}
          iStarted={iStarted}
          gameplayEvent$={events$}
          betSize={String(perGameAmount)}
          unitSizeMojos={spacepokerUnitSizeMojos}
          onTurnChanged={turnHandler}
          appendGameLog={logHandler}
          perGameAmount={perGameAmount}
          myName={myName}
          opponentName={opponentName}
          settlementOutcomeOverride={settlementOutcome}
        />
      );
    }
    if (gameType === 'krunk') {
      return (
        <KrunkHand
          key={handKey}
          gameObject={gameObject}
          currentHandGameIds={currentHandGameIds}
          activeGameIds={activeGameIds}
          iProposedHand={iProposedHand}
          gameplayEvent$={events$}
          betSize={perGameAmount}
          onTurnChanged={turnHandler}
          appendGameLog={logHandler}
          myName={myName}
          opponentName={opponentName}
          frozen={mode === 'frozen'}
          gameSettlementOutcomes={gameSettlementOutcomes}
        />
      );
    }
    return (
      <div className='flex items-center justify-center py-20'>
        <p className='text-canvas-text'>
          Game not supported: {gameDisplayName(gameType)}
        </p>
      </div>
    );
  })();

  // Keep this element stable through live → frozen. Changing only its
  // interaction attributes preserves the mounted game subtree and its UI
  // state, whereas adding a wrapper only for frozen mode remounts it.
  return (
    <div
      className={`relative h-full w-full min-h-0${mode === 'frozen' ? ' pointer-events-none' : ''}`}
      aria-disabled={mode === 'frozen' || undefined}
    >
      {content}
    </div>
  );
}
