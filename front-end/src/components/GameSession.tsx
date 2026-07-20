import { Component, useCallback, useEffect, useRef, useState, type RefObject, type ReactNode, type ErrorInfo } from 'react';
import { Observable } from 'rxjs';
import { useGameSession, isValidKrunkStake, ChannelStatusInfo, GameTerminalAttentionInfo, GameTurnState, GameplayEvent, QueuedNotification } from '../hooks/useGameSession';
import { useCalpokerHand } from '../hooks/useCalpokerHand';
import { CalpokerDisplaySnapshot, SessionSave } from '../hooks/save';
import { formatMojos, formatAmount } from '../util';
import { getPlayerId } from '../hooks/save';
import { CalpokerOutcome, SessionPhase } from '../types/ChiaGaming';
import { SessionController, RestoreStatus } from '../hooks/SessionController';
import type { BlockchainPoller } from '../hooks/BlockchainPoller';
import Calpoker from '../features/calPoker';
import {
  CalpokerDisplaySnapshotView,
  CalpokerOutcomeView,
} from '../types/californiaPoker/CaliforniapokerProps';
import SpacePoker from './SpacePoker';
import Krunk from './Krunk';
import { GAME_REGISTRY, gameDisplayName } from '../lib/gameRegistry';
import { isErrorSettlementOutcome } from '../lib/settlement';
import {
  channelStateNeedsGameTabAttention,
  gameplayEventNeedsGameTabAttention,
  peerProposalIdNeedsGameTabAttention,
} from '../lib/gameTabAttention';
import {
  DEFAULT_GAME_TIMEOUT_BLOCKS,
  selectComposeAmountAfterGameTypeChoice,
  selectHideGameInterfaceForBetweenHandDialog,
  type SessionModel,
} from '../lib/session/model';
import type { ChannelStatus } from '../types/ChiaGaming';

const PRE_ACTIVE_STATES: ReadonlySet<ChannelStatus> = new Set([
  'Handshaking', 'WaitingForHeightToOffer', 'WaitingForHeightToAccept',
  'OurWalletMakingOffer', 'OurWalletMakingOfferAcceptance', 'OfferSent', 'TransactionPending',
]);

import { motion, useMotionValue, useDragControls } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Separator } from './ui/separator';
import { Button } from './button';
import { AmountInput } from './AmountInput';

interface ErrorBoundaryProps { children: ReactNode; }
interface ErrorBoundaryState {
  error: string | null;
  componentStack: string | null;
  dialogDismissed: boolean;
}

function RenderErrorDialog({
  title,
  error,
  componentStack,
  onDismiss,
  onReload,
}: {
  title: string;
  error: string;
  componentStack: string | null;
  onDismiss?: () => void;
  onReload?: () => void;
}) {
  return (
    <div
      className='fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4'
      role='alertdialog'
      aria-modal='true'
      aria-labelledby='render-error-title'
    >
      <div className='flex max-h-[90vh] w-full max-w-2xl flex-col gap-3 overflow-hidden rounded-lg border border-alert-text bg-canvas-bg p-4 text-canvas-text shadow-xl'>
        <div>
          <h2 id='render-error-title' className='text-lg font-semibold text-alert-text'>{title}</h2>
          <p className='mt-1 text-sm text-canvas-text'>
            The game UI hit a render error. The session shell is still running; details are shown below.
          </p>
        </div>
        <pre className='max-h-56 overflow-auto whitespace-pre-wrap break-all rounded border border-canvas-line bg-canvas-bg-subtle p-3 text-xs select-text cursor-text'>{error}</pre>
        {componentStack && (
          <pre className='max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-canvas-line bg-canvas-bg-subtle p-3 text-xs select-text cursor-text'>{componentStack}</pre>
        )}
        <div className='flex flex-wrap justify-end gap-2'>
          {onDismiss && (
            <Button variant='outline' size='sm' onClick={onDismiss}>
              Dismiss
            </Button>
          )}
          {onReload && (
            <Button variant='solid' size='sm' onClick={onReload}>
              Reload
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export class GameSessionErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null, dialogDismissed: false };

  static getDerivedStateFromError(err: Error): ErrorBoundaryState {
    return { error: err.stack || err.message, componentStack: null, dialogDismissed: false };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error('[GameSession] render crash:', err, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  render() {
    if (this.state.error) {
      return (
        <div className='flex flex-col items-center justify-center gap-4 w-full h-full p-8 text-canvas-text'>
          <h2 className='text-xl font-semibold text-alert-text'>Something went wrong</h2>
          <p className='text-sm text-canvas-text'>The session renderer crashed. Reloading is the safest recovery.</p>
          <RenderErrorDialog
            title='Session renderer crashed'
            error={this.state.error}
            componentStack={this.state.componentStack}
            onReload={() => window.location.reload()}
          />
          <button
            className='px-4 py-2 rounded bg-canvas-solid text-canvas-bg-subtle hover:opacity-90'
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

interface GameAreaErrorBoundaryProps {
  children: ReactNode;
  resetKey: string;
}

class GameAreaErrorBoundary extends Component<GameAreaErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null, dialogDismissed: false };

  static getDerivedStateFromError(err: Error): ErrorBoundaryState {
    return { error: err.stack || err.message, componentStack: null, dialogDismissed: false };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error('[GameSession] game render crash:', err, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  componentDidUpdate(prevProps: GameAreaErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, componentStack: null, dialogDismissed: false });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <>
          {!this.state.dialogDismissed && (
            <RenderErrorDialog
              title='Game renderer crashed'
              error={this.state.error}
              componentStack={this.state.componentStack}
              onDismiss={() => this.setState({ dialogDismissed: true })}
            />
          )}
          <div className='rounded-md border border-alert-text bg-canvas-bg p-4 text-sm text-canvas-text'>
            <h2 className='mb-2 font-semibold text-alert-text'>Game renderer crashed</h2>
            <p className='mb-3 text-canvas-text'>The rest of the session is still available.</p>
            <Button variant='outline' size='sm' onClick={() => this.setState({ dialogDismissed: false })}>
              Show Error Details
            </Button>
          </div>
        </>
      );
    }
    return this.props.children;
  }
}

function CoinId({ hex }: { hex: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(`0x${hex}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-mono text-[11px] select-all text-canvas-text-contrast">0x{hex}</span>
      <button
        onClick={copy}
        className="inline-flex items-center p-0.5 rounded hover:bg-canvas-bg-hover transition-colors text-canvas-solid hover:text-canvas-text-contrast"
        title="Copy coin ID"
      >
        {copied ? (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
            <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
            <path d="M7 3.5A1.5 1.5 0 0 1 8.5 2h3.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 17 6.622V12.5a1.5 1.5 0 0 1-1.5 1.5h-1v-3.379a3 3 0 0 0-.879-2.121L10.5 5.379A3 3 0 0 0 8.379 4.5H7v-1Z" />
            <path d="M4.5 6A1.5 1.5 0 0 0 3 7.5v9A1.5 1.5 0 0 0 4.5 18h7a1.5 1.5 0 0 0 1.5-1.5v-5.879a1.5 1.5 0 0 0-.44-1.06L9.44 6.439A1.5 1.5 0 0 0 8.378 6H4.5Z" />
          </svg>
        )}
      </button>
    </span>
  );
}

function formatOptionalMojos(raw: string | null): string {
  if (raw == null) return '—';
  try {
    return formatMojos(BigInt(raw));
  } catch {
    return raw;
  }
}

function useViewportClampedDragWithInsets(
  boundsRef: RefObject<HTMLElement | null> | undefined,
  insets: { top?: number; right?: number; bottom?: number; left?: number } = {},
) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);

  const clampToViewport = useCallback(() => {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const boundsRect = boundsRef?.current?.getBoundingClientRect();
    const minX = (boundsRect?.left ?? 0) + (insets.left ?? 0);
    const minY = (boundsRect?.top ?? 0) + (insets.top ?? 0);
    const maxX = (boundsRect?.right ?? window.innerWidth) - (insets.right ?? 0);
    const maxY = (boundsRect?.bottom ?? window.innerHeight) - (insets.bottom ?? 0);
    let nextX = x.get();
    let nextY = y.get();

    if (rect.width >= maxX - minX) {
      nextX -= rect.left - minX;
    } else {
      if (rect.left < minX) nextX -= rect.left - minX;
      if (rect.right > maxX) nextX -= rect.right - maxX;
    }

    if (rect.height >= maxY - minY) {
      nextY -= rect.top - minY;
    } else {
      if (rect.top < minY) nextY -= rect.top - minY;
      if (rect.bottom > maxY) nextY -= rect.bottom - maxY;
    }

    if (nextX !== x.get()) x.set(nextX);
    if (nextY !== y.get()) y.set(nextY);
  }, [boundsRef, insets.bottom, insets.left, insets.right, insets.top, x, y]);

  useEffect(() => {
    const onResize = () => clampToViewport();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampToViewport]);

  return { cardRef, x, y, clampToViewport };
}


function ChannelStatusContent({ info }: { info: ChannelStatusInfo }) {
  return (
    <>
      {info.advisory && (
        <p className='text-sm text-canvas-text-contrast select-text cursor-text'>{info.advisory}</p>
      )}
      {info.coinHex && (
        <p className='text-xs text-canvas-text break-all select-text cursor-text'>
          Coin ID: <CoinId hex={info.coinHex} />
        </p>
      )}
      {info.coinAmount && (
        <p className='text-xs text-canvas-text select-text cursor-text'>
          Coin amount: {formatOptionalMojos(info.coinAmount)}
        </p>
      )}
    </>
  );
}

function GameTerminalContent({ info }: { info: GameTerminalAttentionInfo }) {
  return (
    <div className='rounded-md border border-canvas-line bg-canvas-bg p-3 text-sm space-y-2 select-text cursor-text'>
      <p className='flex flex-wrap items-center gap-x-2 gap-y-1'>
        <span className='text-canvas-text'>My reward:</span>
        <span className='font-semibold text-canvas-text-contrast'>
          {formatOptionalMojos(info.myReward)}
        </span>
      </p>
      <p className='flex flex-wrap items-center gap-x-2 gap-y-1'>
        <span className='text-canvas-text'>Reward coin ID:</span>
        {info.rewardCoinHex ? (
          <CoinId hex={info.rewardCoinHex} />
        ) : (
          <span className='font-semibold text-canvas-text-contrast'>None</span>
        )}
      </p>
    </div>
  );
}

function NotificationOverlay({
  notification,
  onDismiss,
  boundsRef,
  zClass,
}: {
  notification: QueuedNotification;
  onDismiss: () => void;
  boundsRef: RefObject<HTMLElement | null>;
  zClass: string;
}) {
  const { cardRef, x, y, clampToViewport } = useViewportClampedDragWithInsets(boundsRef, { top: 8 });
  const dragControls = useDragControls();
  const isError = notification.kind === 'infra-error' || notification.kind === 'action-failed';
  const titleColor = 'text-canvas-text-contrast';

  return (
    <motion.div
      key={String(notification.id)}
      ref={cardRef}
      drag
      dragControls={dragControls}
      dragListener={false}
      dragMomentum={false}
      dragElastic={0}
      initial={false}
      style={{ x, y }}
      onDrag={clampToViewport}
      onDragEnd={clampToViewport}
      className={`absolute ${zClass} left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2`}
    >
      <Card className='theme-inverted w-full max-w-md shadow-xl bg-canvas-bg-subtle border border-canvas-line'>
        <CardHeader
          className='text-center pb-2 cursor-grab active:cursor-grabbing'
          onPointerDown={(e) => dragControls.start(e)}
        >
          <CardTitle className={`text-xl ${titleColor}`}>{notification.title}</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className='pt-4 flex flex-col gap-2'>
          {notification.kind === 'channel-state' && notification.payload && 'state' in notification.payload && (
            <ChannelStatusContent info={notification.payload as ChannelStatusInfo} />
          )}
          {notification.kind === 'game-terminal' && notification.payload && 'label' in notification.payload && (
            <GameTerminalContent info={notification.payload as GameTerminalAttentionInfo} />
          )}
          {isError && notification.message && (
            <pre className='text-sm text-canvas-text-contrast whitespace-pre-wrap break-all font-sans select-text cursor-text max-h-[60vh] overflow-auto'>{notification.message}</pre>
          )}
          {!isError && notification.kind !== 'channel-state' && notification.kind !== 'game-terminal' && notification.message && (
            <p className='text-sm text-canvas-text-contrast text-center select-text cursor-text'>{notification.message}</p>
          )}
          <Button variant='solid' size='sm' onClick={onDismiss} className='self-center min-w-[96px]'>
            Dismiss
          </Button>
        </CardContent>
      </Card>
    </motion.div>
  );
}

interface CalpokerHandProps {
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
}

function stringifyCalpokerSnapshot(snapshot: CalpokerDisplaySnapshot | undefined): CalpokerDisplaySnapshotView | undefined {
  if (!snapshot) return undefined;
  return {
    ...snapshot,
    playerBestHandCardIds: snapshot.playerBestHandCardIds.map(String),
    opponentBestHandCardIds: snapshot.opponentBestHandCardIds.map(String),
    playerHaloCardIds: snapshot.playerHaloCardIds.map(String),
    opponentHaloCardIds: snapshot.opponentHaloCardIds.map(String),
  };
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
}: CalpokerHandProps) {
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
    lines.forEach(l => appendGameLog(l));
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
      settlementOutcome={settlementOutcome}
    />
  );
}

interface SpacePokerHandProps {
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
}: SpacePokerHandProps) {
  const unitMojos = unitSizeMojos ? BigInt(unitSizeMojos) : 1n;
  const stackSize = unitMojos > 0n ? perGameAmount / unitMojos : 0n;
  const handleTurnChanged = useCallback(
    (isMyTurn: boolean) => onTurnChanged(gameId, isMyTurn),
    [gameId, onTurnChanged],
  );

  const handleGameLog = useCallback((lines: string[]) => {
    appendGameLog(`Space Poker ${stackSize} (${formatAmount(unitMojos)})`);
    lines.forEach(l => appendGameLog(l));
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
    />
  );
}


function ComposeProposalDialog({
  session,
  maxPerHandMojos,
}: {
  session: import('../hooks/useGameSession').UseGameSessionResult;
  maxPerHandMojos: bigint | null;
}) {
  const defaultSpacePokerStackSize = 10;
  const isSpacepoker = session.composeGameType === 'spacepoker';
  const isKrunk = session.composeGameType === 'krunk';
  const [spUnitSize, setSpUnitSize] = useState(() => {
    const remembered = session.lastHandTerms.gameType === 'spacepoker'
      ? session.lastHandTerms.spacepokerUnitSize
      : undefined;
    if (remembered && remembered > 0n) return remembered;
    const stake = session.composePerHandAmount;
    if (stake <= 0n) return 1n;
    return (stake + BigInt(defaultSpacePokerStackSize - 1)) / BigInt(defaultSpacePokerStackSize);
  });
  const [spStackSizeStr, setSpStackSizeStr] = useState(() => {
    const remembered = session.lastHandTerms.gameType === 'spacepoker'
      ? session.lastHandTerms.spacepokerUnitSize
      : undefined;
    if (remembered && remembered > 0n && session.composePerHandAmount > 0n) {
      return String(session.composePerHandAmount / remembered);
    }
    return String(defaultSpacePokerStackSize);
  });
  const spStackSize = parseInt(spStackSizeStr) || 0;
  const [timeoutStr, setTimeoutStr] = useState(() =>
    String(session.composeGameTimeout > 0n ? session.composeGameTimeout : DEFAULT_GAME_TIMEOUT_BLOCKS)
  );
  useEffect(() => {
    setTimeoutStr(String(session.composeGameTimeout > 0n ? session.composeGameTimeout : DEFAULT_GAME_TIMEOUT_BLOCKS));
  }, [session.composeGameTimeout]);
  const gameTimeout = BigInt(timeoutStr || '0');
  const timeoutValid = gameTimeout > 0n;

  const spBetSize = isSpacepoker ? spUnitSize * BigInt(spStackSize) : 0n;
  const spTotalGame = spBetSize * 2n;
  const spExceedsBalance = maxPerHandMojos != null && spBetSize > maxPerHandMojos;
  const spValid = isSpacepoker && spUnitSize > 0n && spStackSize > 0 && !spExceedsBalance;
  const spMaxUnitSize = maxPerHandMojos != null && spStackSize > 0
    ? maxPerHandMojos / BigInt(spStackSize)
    : null;

  const perHandAmount = isSpacepoker ? spBetSize : session.composePerHandAmount;
  const krunkStakeValid = !isKrunk || isValidKrunkStake(perHandAmount);
  const standardMaxMojos = isKrunk && maxPerHandMojos != null
    ? maxPerHandMojos - (maxPerHandMojos % 100n)
    : maxPerHandMojos;

  const submit = () => {
    if (
      perHandAmount <= 0n
      || !timeoutValid
      || !krunkStakeValid
      || session.composeProposalSent
    ) return;
    session.submitComposedProposal(
      perHandAmount,
      session.composeGameType,
      gameTimeout,
      isSpacepoker ? spUnitSize : undefined,
    );
  };
  const selectGameType = (gameType: string) => {
    session.setComposePerHandAmount(selectComposeAmountAfterGameTypeChoice(
      session.composeGameType,
      gameType,
      session.composePerHandAmount,
    ));
    session.setComposeGameType(gameType);
  };

  return (
    <div className='mx-auto w-full max-w-xl rounded-md border border-canvas-line bg-canvas-bg p-4 text-center'>
      <div className='flex flex-col items-center gap-3'>
        <p className='text-sm text-canvas-text-contrast'>Propose terms for the next hand.</p>
        <div className='flex w-full flex-col items-center gap-1'>
          <div className='flex flex-wrap justify-center gap-2'>
            {GAME_REGISTRY.map(({ gameType, displayName }) => (
              <Button
                key={gameType}
                variant={session.composeGameType === gameType ? 'solid' : 'outline'}
                color={session.composeGameType === gameType ? 'primary' : 'neutral'}
                size='sm'
                disabled={session.composeProposalSent}
                onClick={() => selectGameType(gameType)}
              >
                {displayName}
              </Button>
            ))}
          </div>
        </div>

        {isSpacepoker ? (
          <>
            <AmountInput
              valueMojos={spUnitSize}
              onChange={setSpUnitSize}
              maxMojos={spMaxUnitSize}
              onUseMax={spMaxUnitSize != null && spMaxUnitSize > 0n ? () => setSpUnitSize(spMaxUnitSize) : undefined}
              disabled={session.composeProposalSent}
              label='Unit size'
              exceedsLabel='Exceeds available reserve.'
              onKeyDown={(e) => { if (e.key === 'Enter' && spValid && timeoutValid) submit(); }}
            />
            <div className='flex w-full flex-col items-center gap-1'>
              <label className='text-xs font-medium text-canvas-text'>Stack size (units per player)</label>
              <input
                type='number'
                min={1}
                className='w-full rounded border border-canvas-line bg-canvas-bg px-2 py-1 text-center text-sm text-canvas-text-contrast focus:outline-none focus:ring-1 focus:ring-canvas-solid'
                value={spStackSizeStr}
                disabled={session.composeProposalSent}
                onChange={(e) => setSpStackSizeStr(e.target.value.replace(/[^0-9]/g, ''))}
                onKeyDown={(e) => { if (e.key === 'Enter' && spValid && timeoutValid) submit(); }}
              />
            </div>
            <div className='text-xs text-canvas-text'>
              Per-player stake: {formatMojos(spBetSize)} · Total game size: {formatMojos(spTotalGame)}
            </div>
          </>
        ) : (
          <AmountInput
            valueMojos={session.composePerHandAmount}
            onChange={session.setComposePerHandAmount}
            maxMojos={standardMaxMojos}
            onUseMax={standardMaxMojos != null && standardMaxMojos > 0n
              ? () => session.setComposePerHandAmount(standardMaxMojos)
              : undefined}
            disabled={session.composeProposalSent}
            label='Per-player stake'
            exceedsLabel='Exceeds available reserve.'
            onKeyDown={(e) => {
              if (
                e.key === 'Enter'
                && !session.composeProposalSent
                && session.composePerHandAmount > 0n
                && timeoutValid
                && krunkStakeValid
              ) submit();
            }}
          />
        )}
        {isKrunk && perHandAmount > 0n && !krunkStakeValid && (
          <p className='text-xs text-alert-text'>
            Krunk stakes must be multiples of 100 mojos.
          </p>
        )}

        <div className='flex w-full flex-col items-center gap-1'>
          <label className='text-xs font-medium text-canvas-text'>Timeout (blocks)</label>
          <input
            type='number'
            min={1}
            className='w-full rounded border border-canvas-line bg-canvas-bg px-2 py-1 text-center text-sm text-canvas-text-contrast focus:outline-none focus:ring-1 focus:ring-canvas-solid'
            value={timeoutStr}
            disabled={session.composeProposalSent}
            onChange={(e) => {
              const next = e.target.value.replace(/[^0-9]/g, '');
              setTimeoutStr(next);
              if (next) {
                session.setComposeGameTimeout(BigInt(next));
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
        </div>

        <Button
          variant='solid'
          color='primary'
          size='sm'
          className='self-center'
          disabled={
            session.composeProposalSent ||
            perHandAmount <= 0n ||
            !timeoutValid ||
            !krunkStakeValid ||
            (isSpacepoker && !spValid)
          }
          onClick={submit}
        >
          {session.composeProposalSent ? 'Proposal Sent' : 'Send Proposal'}
        </Button>
      </div>
    </div>
  );
}

function ReviewProposalDialog({
  session,
}: {
  session: import('../hooks/useGameSession').UseGameSessionResult;
}) {
  const review = session.reviewPeerProposal;
  if (!review) return null;

  return (
    <div className='mx-auto w-full max-w-xl rounded-md border border-canvas-line bg-canvas-bg p-4'>
      <div className='flex flex-col gap-3'>
        <p className='text-sm text-canvas-text-contrast'>Do you want to accept this hand?</p>
        <p className='text-xs text-canvas-text'>
          Game: {gameDisplayName(review.terms.gameType)}
        </p>
        <p className='text-xs text-canvas-text'>
          Per-player stake: {formatMojos(review.terms.myContribution)}
        </p>
        <p className='text-xs text-canvas-text'>
          Timeout: {String(review.terms.gameTimeout)} blocks
        </p>
        {review.terms.gameType === 'spacepoker' && (() => {
          const betSize = review.terms.myContribution;
          const betUnit = review.terms.spacepokerUnitSize;
          return betUnit && betUnit > 0n ? (
            <p className='text-xs text-canvas-text'>
              Unit size: {formatMojos(betUnit)} · Stack: {String(betSize / betUnit)} units
            </p>
          ) : null;
        })()}
        <div className='flex flex-wrap items-center gap-3'>
          <Button
            variant='solid'
            color='primary'
            size='sm'
            onClick={session.acceptReviewedProposal}
          >
            Yes
          </Button>
          <Button variant='solid' size='sm' onClick={session.rejectReviewedProposal}>
            No
          </Button>
        </div>
      </div>
    </div>
  );
}

export interface GameSessionProps {
  params: import('../types/ChiaGaming').GameSessionParams;
  peerConn: import('../types/ChiaGaming').PeerConnectionResult;
  registerMessageHandler: (handler: (msgno: number, msg: Uint8Array) => void, ackHandler: (ack: number) => void, keepaliveHandler: () => void) => void;
  appendGameLog: (line: string) => void;
  sessionSave?: import('../hooks/save').SessionSave;
  onGameActivity?: () => void;
  onSessionPhaseChange?: (phase: Exclude<SessionPhase, 'none'>, hasError: boolean) => void;
  onRestoreStatusChange?: (status: RestoreStatus, error: string | null) => void;
  onSessionModelChange?: (model: SessionModel) => void;
  onProtocolStateProviderChange?: (getter: (() => string | null) | null) => void;
  onCoinsProviderChange?: (getter: (() => import('../types/ChiaGaming').CoinOfInterestEntry[]) | null) => void;
  suppressPhaseReporting?: boolean;
  blockchain: BlockchainPoller | null;
  onTerminal?: () => void;
}

const GameSession: React.FC<GameSessionProps> = ({ params, peerConn, registerMessageHandler, appendGameLog, sessionSave, onGameActivity, onSessionPhaseChange, onRestoreStatusChange, onSessionModelChange, onProtocolStateProviderChange, onCoinsProviderChange, suppressPhaseReporting, blockchain, onTerminal }) => {
  const uniqueId = getPlayerId();

  const session = useGameSession(params, uniqueId, peerConn, registerMessageHandler, appendGameLog, sessionSave, blockchain, onTerminal);

  useEffect(() => {
    onRestoreStatusChange?.(session.restoreStatus, session.restoreError);
  }, [session.restoreStatus, session.restoreError, onRestoreStatusChange]);

  useEffect(() => {
    onSessionModelChange?.(session.sessionModel);
  }, [session.sessionModel, onSessionModelChange]);

  useEffect(() => {
    if (!onProtocolStateProviderChange) return;
    const gameObject = session.sessionController;
    onProtocolStateProviderChange(() => gameObject.getProtocolStatePretty());
    return () => onProtocolStateProviderChange(null);
  }, [session.sessionController, onProtocolStateProviderChange]);

  useEffect(() => {
    if (!onCoinsProviderChange) return;
    const gameObject = session.sessionController;
    onCoinsProviderChange(() => gameObject.getCoinsOfInterest());
    return () => onCoinsProviderChange(null);
  }, [session.sessionController, onCoinsProviderChange]);

  useEffect(() => {
    if (!onSessionPhaseChange || suppressPhaseReporting) return;
    const phase = session.sessionPhase;
    const settledOutcome = session.gameTerminal.outcome;
    const hasError =
      session.channelStatus.state === 'Failed' ||
      session.channelStatus.state === 'ResolvedStale' ||
      session.gameTerminal.type === 'game-error' ||
      (session.gameTerminal.type === 'settled'
        && settledOutcome != null
        && isErrorSettlementOutcome(settledOutcome));
    onSessionPhaseChange(phase, hasError);
  }, [session.sessionPhase, session.channelStatus.state, session.gameTerminal.type, session.gameTerminal.outcome, onSessionPhaseChange, suppressPhaseReporting]);

  useEffect(() => {
    if (!onGameActivity) return;
    const sub = session.gameplayEvent$.subscribe((evt) => {
      if (gameplayEventNeedsGameTabAttention(evt)) {
        onGameActivity();
      }
    });
    return () => sub.unsubscribe();
  }, [session.gameplayEvent$, onGameActivity]);

  const prevGameQueueLen = useRef(session.gameQueue.length);
  const prevChannelQueueLen = useRef(session.channelQueue.length);
  useEffect(() => {
    const grew = session.gameQueue.length > prevGameQueueLen.current ||
                 session.channelQueue.length > prevChannelQueueLen.current;
    prevGameQueueLen.current = session.gameQueue.length;
    prevChannelQueueLen.current = session.channelQueue.length;
    if (grew) onGameActivity?.();
  }, [session.gameQueue.length, session.channelQueue.length, onGameActivity]);

  // Rising edge: peer hand proposal enters review (skip restore/hydration).
  const prevBetweenHandMode = useRef(session.betweenHandMode);
  useEffect(() => {
    const prev = prevBetweenHandMode.current;
    prevBetweenHandMode.current = session.betweenHandMode;
    if (
      session.betweenHandMode === 'review-incoming-proposal'
      && prev !== 'review-incoming-proposal'
    ) {
      onGameActivity?.();
    }
  }, [session.betweenHandMode, onGameActivity]);

  // Rising edge: proposal cached in decision mode, or replaced while reviewing.
  // Combined id so promoting cache → review does not double-fire.
  const attentionProposalId =
    session.reviewPeerProposal?.id ?? session.cachedPeerProposal?.id ?? null;
  const prevAttentionProposalId = useRef(attentionProposalId);
  useEffect(() => {
    const prev = prevAttentionProposalId.current;
    prevAttentionProposalId.current = attentionProposalId;
    if (peerProposalIdNeedsGameTabAttention(prev, attentionProposalId)) {
      onGameActivity?.();
    }
  }, [attentionProposalId, onGameActivity]);

  // Rising edge: clean shutdown / going on-chain begins (skip restore and
  // transitions between already-attention channel states).
  const prevChannelAttention = useRef(
    channelStateNeedsGameTabAttention(session.channelStatus.state),
  );
  useEffect(() => {
    const next = channelStateNeedsGameTabAttention(session.channelStatus.state);
    const prev = prevChannelAttention.current;
    prevChannelAttention.current = next;
    if (next && !prev) {
      onGameActivity?.();
    }
  }, [session.channelStatus.state, onGameActivity]);

  const channelOverlayBoundsRef = useRef<HTMLDivElement | null>(null);
  const gameAreaRef = useRef<HTMLDivElement | null>(null);

  const maxPerHandMojos = (() => {
    const ours = session.channelStatus.ourBalance;
    const theirs = session.channelStatus.theirBalance;
    if (ours == null || theirs == null) return null;
    try {
      const a = BigInt(ours);
      const b = BigInt(theirs);
      return a < b ? a : b;
    } catch {
      return null;
    }
  })();

  const handEverStarted = session.handKey > 0;
  const hasPersistedGameState = !!session.gameSpecificView.handState;
  const hideGameInterfaceForBetweenHandDialog = selectHideGameInterfaceForBetweenHandDialog(
    session.betweenHands,
    session.betweenHandMode,
  );
  const gameSpecificView = session.gameSpecificView;
  const showGameInterface = handEverStarted && (!!gameSpecificView.displayGameId || hasPersistedGameState) && !hideGameInterfaceForBetweenHandDialog;

  if (suppressPhaseReporting) {
    return (
      <div className='w-full h-full flex items-center justify-center text-canvas-solid'>
        Restoring session...
      </div>
    );
  }

  return (
    <div className='relative w-full h-full min-h-0 flex flex-col bg-canvas-bg-subtle text-canvas-text pt-6'>
      <div ref={channelOverlayBoundsRef} className='absolute inset-0 pointer-events-none' />
      {session.gameQueue[0] && (
        <NotificationOverlay
          notification={session.gameQueue[0]}
          onDismiss={session.dismissGame}
          boundsRef={channelOverlayBoundsRef}
          zClass='z-40'
        />
      )}
      {/* Main content area */}
      <div className='flex flex-col gap-2 px-4 pb-2 sm:px-6 md:px-8'>
        {/* Game area — z-0 creates a stacking context so card zIndexes (up to 100) can't escape */}
          <div ref={gameAreaRef} className='relative overflow-hidden z-0'>
          {showGameInterface && (
            <GameAreaErrorBoundary
              resetKey={`${gameSpecificView.gameType}:${session.handKey}:${session.activeGameId ?? gameSpecificView.displayGameId ?? ''}`}
            >
              {gameSpecificView.gameType === 'calpoker' ? (
                <CalpokerHand
                  key={session.handKey}
                  gameObject={session.sessionController}
                  gameId={session.activeGameId ?? gameSpecificView.displayGameId ?? ''}
                  iStarted={session.iStarted}
                  playerNumber={session.playerNumber}
                  gameplayEvent$={session.gameplayEvent$}
                  onOutcome={session.onHandOutcome}
                  onTurnChanged={session.onTurnChanged}
                  appendGameLog={session.appendGameLog}
                  perGameAmount={session.currentHandAmount}
                  myName={params.myAlias}
                  opponentName={params.opponentAlias}
                />
              ) : gameSpecificView.gameType === 'spacepoker' ? (
                <SpacePokerHand
                  key={session.handKey}
                  gameObject={session.sessionController}
                  gameId={session.activeGameId ?? gameSpecificView.displayGameId ?? ''}
                  iStarted={session.iStarted}
                  gameplayEvent$={session.gameplayEvent$}
                  betSize={String(session.currentHandAmount)}
                  unitSizeMojos={session.lastHandTerms.gameType === 'spacepoker' && session.lastHandTerms.spacepokerUnitSize
                    ? String(session.lastHandTerms.spacepokerUnitSize)
                    : undefined}
                  onTurnChanged={session.onTurnChanged}
                  appendGameLog={session.appendGameLog}
                  perGameAmount={session.currentHandAmount}
                  myName={params.myAlias}
                  opponentName={params.opponentAlias}
                />
              ) : gameSpecificView.gameType === 'krunk' ? (
                <Krunk
                  key={session.handKey}
                  gameObject={session.sessionController}
                  currentHandGameIds={session.currentHandGameIds}
                  activeGameIds={session.activeGameIds}
                  iProposedHand={session.iProposedHand}
                  gameplayEvent$={session.gameplayEvent$}
                  betSize={session.currentHandAmount}
                  onTurnChanged={session.onTurnChanged}
                  myName={params.myAlias}
                  opponentName={params.opponentAlias}
                />
              ) : (
                <div className='flex items-center justify-center py-20'>
                  <p className='text-canvas-text'>
                    Game not supported: {gameDisplayName(gameSpecificView.gameType)}
                  </p>
                </div>
              )}
            </GameAreaErrorBoundary>
          )}

          {(!handEverStarted || PRE_ACTIVE_STATES.has(session.channelStatus.state)) && (
            <div className='flex items-center justify-center py-20'>
              <p className='text-canvas-text'>Setting up channel…</p>
            </div>
          )}
          {handEverStarted && !PRE_ACTIVE_STATES.has(session.channelStatus.state) && !gameSpecificView.displayGameId && !hasPersistedGameState && !session.betweenHands && (
            <div className='flex items-center justify-center py-20'>
              <p className='text-canvas-text'>Waiting for next hand…</p>
            </div>
          )}

        </div>

        {/* Between-hand session controls — only when the channel is Active */}
        {session.betweenHands && session.channelStatus.state === 'Active' && !session.cleanShutdownStarted && (
          <>
            {session.betweenHandMode === 'decision' && (
              <div className='relative flex w-full items-center justify-center py-2'>
                <Button
                  variant='solid'
                  color='primary'
                  size='sm'
                  onClick={session.chooseNewHandSameTerms}
                  disabled={session.newHandRequested}
                >
                  {session.newHandRequested ? 'Waiting\u2026' : 'New Hand'}
                </Button>
                <Button
                  variant='ghost'
                  color='neutral'
                  size='sm'
                  className='absolute right-2'
                  onClick={session.chooseDoNotUseCurrentProposal}
                  leadingIcon={<span className='text-base leading-none'>&times;</span>}
                >
                  Close
                </Button>
              </div>
            )}

            {session.betweenHandMode === 'compose-proposal' && (
              <ComposeProposalDialog
                session={session}
                maxPerHandMojos={maxPerHandMojos}
              />
            )}

            {session.betweenHandMode === 'review-incoming-proposal' && session.reviewPeerProposal && (
              <ReviewProposalDialog session={session} />
            )}
          </>
        )}
      </div>

      {session.channelQueue[0] && (
        <NotificationOverlay
          notification={session.channelQueue[0]}
          onDismiss={session.dismissChannel}
          boundsRef={channelOverlayBoundsRef}
          zClass='z-50'
        />
      )}
    </div>
  );
};

export default GameSession;
