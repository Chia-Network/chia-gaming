import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Observable } from 'rxjs';
import {
  useKrunkHand,
  canDraftKrunkGuess,
  canQueueKrunkGuess,
  isKrunkDictionaryRejectionError,
  krunkBoardNotice,
  krunkGuessesWithQueued,
  KrunkHandler,
  KrunkGuess,
  KrunkRole,
} from './useKrunkHand';
import {
  defaultFormatAmount,
  type GameHandSource,
  type GameplayEvent,
  type GameTerminalModel,
  type PersistedGameState,
} from '../../host';
import { useGameHost, useInitialGameHandState } from '../../host/ui';
import { krunkStateCodec } from './serialize';

export interface KrunkProps {
  handSource: GameHandSource;
  currentHandGameIds: string[];
  activeGameIds: string[];
  gameplayEvent$: Observable<GameplayEvent>;
  onTurnChanged: (gameId: string, isMyTurn: boolean) => void;
  onGameLog: (lines: string[]) => void;
  myName?: string;
  opponentName?: string;
  terminalsById: Record<string, GameTerminalModel>;
  amountsById: Record<string, string>;
}

const CLUE_TILE = ['⬛', '🟧', '🟩'] as const;

/** Session-history lines for one finished Krunk half (picker or guesser). */
export function formatKrunkHandLog(
  role: KrunkRole,
  betSize: bigint,
  guesses: KrunkGuess[],
  revealedWord: string | null,
  formatAmount: (mojos: bigint) => string = defaultFormatAmount,
): string[] {
  const roleLabel = role === 'alice' ? 'picking' : 'guessing';
  const lines = [`Krunk (${roleLabel}) ${formatAmount(betSize)}`];
  for (const g of guesses) {
    lines.push(g.clue.map((v) => CLUE_TILE[Number(v)]).join('') + g.word);
  }
  const solved = guesses.some((g) => g.clue.every((v) => v === 2n));
  if (!solved && revealedWord) {
    lines.push('⬛⬛⬛⬛⬛' + revealedWord);
  }
  return lines;
}

export function krunkGameSlots(
  currentHandGameIds: string[],
  activeGameIds: string[] = currentHandGameIds,
  persistedState?: PersistedGameState | null,
): {
  aliceGameId: string | null;
  bobGameId: string | null;
  aliceActive: boolean;
  bobActive: boolean;
} {
  const persistedGames = krunkStateCodec.decode(persistedState)?.games;
  if (!persistedGames) {
    throw new Error('Krunk requires initialized durable game state');
  }
  const persistedAlice = currentHandGameIds.find((id) => persistedGames?.[id]?.role === 'alice');
  const persistedBob = currentHandGameIds.find((id) => persistedGames?.[id]?.role === 'bob');
  if (
    !currentHandGameIds.every((id) => persistedGames[id]) ||
    !persistedAlice ||
    !persistedBob
  ) {
    throw new Error('Krunk persisted roles must contain one alice and one bob');
  }
  return {
    aliceGameId: persistedAlice,
    bobGameId: persistedBob,
    aliceActive: activeGameIds.includes(persistedAlice),
    bobActive: activeGameIds.includes(persistedBob),
  };
}

export function newlyResolvedKrunkIndex(
  resolvedCount: number,
  previousResolvedCount: number,
): number | undefined {
  return resolvedCount > previousResolvedCount ? resolvedCount - 1 : undefined;
}

const MAX_GUESSES = 5;
const WORD_LEN = 5;
const TILE = 'w-12 h-12 text-xl';
const FLIP_HALF_MS = 400;
const FLIP_STAGGER_MS = 200;
/** Time for one staggered guess row to finish flipping (last letter done). */
const GUESS_ROW_FLIP_MS = (WORD_LEN - 1) * FLIP_STAGGER_MS + 2 * FLIP_HALF_MS;

const CLUE_COLORS: Record<number, { bg: string; border: string }> = {
  2: { bg: '#00875f', border: '#00875f' },
  1: { bg: '#e89f00', border: '#e89f00' },
  0: { bg: '#787c7e', border: '#787c7e' },
};

/** Aggregate keyboard status for one letter across resolved guesses. */
export type KrunkLetterStatus = 'unused' | 'absent' | 'present' | 'correct';

/**
 * Build per-letter keyboard statuses from scored guesses.
 * NYT priority: green > amber > gray. Any green wins; no split key.
 */
export function krunkLetterStatuses(guesses: KrunkGuess[]): Record<string, KrunkLetterStatus> {
  const rank: Record<KrunkLetterStatus, number> = {
    unused: 0,
    absent: 1,
    present: 2,
    correct: 3,
  };
  const out: Record<string, KrunkLetterStatus> = {};
  for (const g of guesses) {
    if (g.clue.every((v) => v === -1n)) continue;
    for (let i = 0; i < 5; i++) {
      const letter = g.word.charAt(i);
      if (!letter) continue;
      const next: KrunkLetterStatus =
        g.clue[i] === 2n
          ? 'correct'
          : g.clue[i] === 1n
            ? 'present'
            : g.clue[i] === 0n
              ? 'absent'
              : 'unused';
      const prev = out[letter] ?? 'unused';
      if (rank[next] > rank[prev]) out[letter] = next;
    }
  }
  return out;
}

const KEYBOARD_ROWS = [
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
  ['Z', 'X', 'C', 'V', 'B', 'N', 'M', '⌫'],
] as const;

function LetterCell({
  letter,
  clueValue,
  flipDelay,
}: {
  letter: string;
  clueValue: bigint;
  flipDelay?: number;
}) {
  // 3 phases: 'idle' (neutral), 'half' (edge-on, swap color), 'done' (revealed)
  const animationDelay = useRef(flipDelay).current;
  const [phase, setPhase] = useState<'idle' | 'half' | 'done'>(
    animationDelay == null ? 'done' : 'idle',
  );

  useEffect(() => {
    if (animationDelay == null) return;
    setPhase('idle');
    const start = setTimeout(() => setPhase('half'), animationDelay);
    return () => clearTimeout(start);
  }, [animationDelay]);

  useEffect(() => {
    if (phase !== 'half') return;
    const fallback = setTimeout(
      () => setPhase((current) => (current === 'half' ? 'done' : current)),
      FLIP_HALF_MS + 100,
    );
    return () => clearTimeout(fallback);
  }, [phase]);

  const showColor = phase === 'done';
  const color = CLUE_COLORS[Number(clueValue)];
  const style: CSSProperties = {
    transition: `transform ${FLIP_HALF_MS}ms ease-in-out`,
    transform: phase === 'half' ? 'rotateX(90deg)' : 'rotateX(0deg)',
    perspective: '600px',
    ...(showColor && color
      ? { backgroundColor: color.bg, borderColor: color.border, color: 'white' }
      : {}),
  };

  return (
    <div
      className={`inline-flex items-center justify-center rounded border border-canvas-line bg-canvas-bg font-bold uppercase tabular-nums select-none text-canvas-text-contrast ${TILE}`}
      style={style}
      onTransitionEnd={(event) => {
        if (event.propertyName === 'transform' && phase === 'half') {
          setPhase('done');
        }
      }}
    >
      {letter}
    </div>
  );
}

function EmptyCell({ letter }: { letter?: string }) {
  return (
    <div
      className={`inline-flex items-center justify-center rounded border border-dashed border-canvas-line bg-canvas-bg font-bold uppercase text-canvas-text-contrast ${TILE}`}
    >
      {letter ?? ''}
    </div>
  );
}

function TargetCell({ letter, flipDelay }: { letter: string; flipDelay?: number }) {
  // Same flip phases as LetterCell. While animating, hide the letter until
  // the card lands — this row reveals the answer, not a typed guess.
  const animationDelay = useRef(flipDelay).current;
  const [phase, setPhase] = useState<'idle' | 'half' | 'done'>(
    animationDelay == null ? 'done' : 'idle',
  );

  useEffect(() => {
    if (animationDelay == null) return;
    setPhase('idle');
    const start = setTimeout(() => setPhase('half'), animationDelay);
    return () => clearTimeout(start);
  }, [animationDelay]);

  useEffect(() => {
    if (phase !== 'half') return;
    const fallback = setTimeout(
      () => setPhase((current) => (current === 'half' ? 'done' : current)),
      FLIP_HALF_MS + 100,
    );
    return () => clearTimeout(fallback);
  }, [phase]);

  const revealed = phase === 'done';
  const style: CSSProperties = {
    transition: `transform ${FLIP_HALF_MS}ms ease-in-out`,
    transform: phase === 'half' ? 'rotateX(90deg)' : 'rotateX(0deg)',
    perspective: '600px',
    ...(revealed ? { backgroundColor: '#e0e0e0', borderColor: '#999', color: 'black' } : {}),
  };

  return (
    <div
      className={`inline-flex items-center justify-center rounded border border-canvas-line bg-canvas-bg font-bold uppercase tabular-nums select-none text-canvas-text-contrast ${TILE}`}
      style={style}
      onTransitionEnd={(event) => {
        if (event.propertyName === 'transform' && phase === 'half') {
          setPhase('done');
        }
      }}
    >
      {revealed ? letter : ''}
    </div>
  );
}

function PendingGuessRow({ word }: { word: string }) {
  return (
    <div className="flex gap-1">
      {[0, 1, 2, 3, 4].map((i) => (
        <EmptyCell key={i} letter={word.charAt(i)} />
      ))}
    </div>
  );
}

function GuessRow({ guess, animate }: { guess: KrunkGuess; animate?: boolean }) {
  const pending = guess.clue.every((v) => v === -1n);
  if (pending) return <PendingGuessRow word={guess.word} />;
  return (
    <div className="flex gap-1">
      {[0, 1, 2, 3, 4].map((i) => (
        <LetterCell
          key={i}
          letter={guess.word.charAt(i)}
          clueValue={guess.clue[i]}
          flipDelay={animate ? i * FLIP_STAGGER_MS : undefined}
        />
      ))}
    </div>
  );
}

function Grid({
  guesses,
  draft,
  showDraftRow,
  latestAnimateIndex,
}: {
  guesses: KrunkGuess[];
  draft?: string;
  showDraftRow?: boolean;
  latestAnimateIndex?: number;
}) {
  const draftLetters = (draft ?? '').split('').slice(0, 5);
  const rows = [];
  for (let i = 0; i < MAX_GUESSES; i++) {
    if (i < guesses.length) {
      rows.push(<GuessRow key={i} guess={guesses[i]} animate={latestAnimateIndex === i} />);
    } else if (showDraftRow && i === guesses.length) {
      rows.push(
        <div key={i} className="flex gap-1">
          {[0, 1, 2, 3, 4].map((j) => (
            <EmptyCell key={j} letter={draftLetters[j]} />
          ))}
        </div>,
      );
    } else {
      rows.push(
        <div key={i} className="flex gap-1">
          {[0, 1, 2, 3, 4].map((j) => (
            <EmptyCell key={j} />
          ))}
        </div>,
      );
    }
  }
  return <div className="flex flex-col gap-1 items-center">{rows}</div>;
}

function TargetRow({ word, animate }: { word: string; animate?: boolean }) {
  return (
    <div className="flex gap-1 mt-2">
      {[0, 1, 2, 3, 4].map((i) => (
        <TargetCell
          key={i}
          letter={word.charAt(i)}
          flipDelay={animate ? i * FLIP_STAGGER_MS : undefined}
        />
      ))}
    </div>
  );
}

function keyBackground(status: KrunkLetterStatus | undefined): CSSProperties {
  if (status === 'correct') {
    return {
      backgroundColor: CLUE_COLORS[2].bg,
      borderColor: CLUE_COLORS[2].border,
      color: 'white',
    };
  }
  if (status === 'present') {
    return {
      backgroundColor: CLUE_COLORS[1].bg,
      borderColor: CLUE_COLORS[1].border,
      color: 'white',
    };
  }
  if (status === 'absent') {
    return {
      backgroundColor: CLUE_COLORS[0].bg,
      borderColor: CLUE_COLORS[0].border,
      color: 'white',
    };
  }
  return {};
}

function KeyboardKey({
  label,
  status,
  wide,
  disabled,
  onPress,
}: {
  label: string;
  status?: KrunkLetterStatus;
  wide?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onPress}
      className={`inline-flex items-center justify-center rounded border border-canvas-line bg-canvas-bg font-bold uppercase select-none text-canvas-text-contrast disabled:opacity-40 ${
        wide ? 'h-12 min-w-[3rem] px-2 text-xs' : 'h-12 w-9 text-sm'
      }`}
      style={keyBackground(status)}
    >
      {label}
    </button>
  );
}

function OnScreenKeyboard({
  statuses,
  disabled,
  onLetter,
  onBackspace,
}: {
  statuses: Record<string, KrunkLetterStatus>;
  disabled?: boolean;
  onLetter: (letter: string) => void;
  onBackspace: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 items-center">
      {KEYBOARD_ROWS.map((row, ri) => (
        <div key={ri} className="flex gap-1.5 justify-center">
          {row.map((key) => {
            if (key === '⌫') {
              return (
                <KeyboardKey key={key} label="⌫" wide disabled={disabled} onPress={onBackspace} />
              );
            }
            return (
              <KeyboardKey
                key={key}
                label={key}
                status={statuses[key]}
                disabled={disabled}
                onPress={() => onLetter(key)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

const Krunk: React.FC<KrunkProps> = ({
  handSource,
  currentHandGameIds,
  activeGameIds,
  gameplayEvent$,
  onTurnChanged,
  onGameLog,
  myName: _myName,
  opponentName,
  terminalsById,
  amountsById,
}) => {
  const { formatAmount } = useGameHost();
  const interactive = handSource.interactionMode === 'live';
  const initialPersistedState = useInitialGameHandState(handSource) ?? undefined;
  const { aliceGameId, bobGameId } = krunkGameSlots(
    currentHandGameIds,
    activeGameIds,
    initialPersistedState,
  );
  const aliceId = aliceGameId ?? '';
  const bobId = bobGameId ?? '';
  const acceptedAmount = amountsById[aliceId] ?? amountsById[bobId];
  if (acceptedAmount === undefined) {
    throw new Error('Krunk is missing the accepted game amount');
  }
  const betSize = BigInt(acceptedAmount);
  // Keep each hand "live" for the whole atomic hand via currentHandGameIds.
  // activeGameIds can drop a sibling during turn/settle handoffs and was
  // latching useKrunkHand into a finished state (blocking clue updates and
  // keyboard input while waiting on a clue).
  const aliceInHand = aliceGameId !== null && currentHandGameIds.includes(aliceGameId);
  const bobInHand = bobGameId !== null && currentHandGameIds.includes(bobGameId);
  const aliceInteractive = interactive && aliceInHand;
  const bobInteractive = interactive && bobInHand;
  const onAliceTurnChanged = useCallback(
    (isMyTurn: boolean) => {
      if (aliceGameId !== null) onTurnChanged(aliceGameId, isMyTurn);
    },
    [aliceGameId, onTurnChanged],
  );
  const onBobTurnChanged = useCallback(
    (isMyTurn: boolean) => {
      if (bobGameId !== null) onTurnChanged(bobGameId, isMyTurn);
    },
    [bobGameId, onTurnChanged],
  );

  // useKrunkHand maps iStarted → role: iStarted=true means bob, false means alice.
  // Alice game (I pick the word): iStarted=false → role='alice'.
  // Bob game (I guess): iStarted=true → role='bob'.
  const aliceHand = useKrunkHand(
    handSource,
    aliceId,
    false,
    gameplayEvent$,
    onAliceTurnChanged,
    aliceInteractive,
    initialPersistedState,
  );

  const bobHand = useKrunkHand(
    handSource,
    bobId,
    true,
    gameplayEvent$,
    onBobTurnChanged,
    bobInteractive,
    initialPersistedState,
  );
  const setAliceSecretWord = aliceHand.setSecretWord;
  const submitBobGuessMove = bobHand.submitGuess;

  // Write each half to the session history panel when it finishes.
  // The two games can complete at different times; log them separately.
  const aliceLogFiredRef = useRef(false);
  const bobLogFiredRef = useRef(false);
  useEffect(() => {
    if (aliceHand.gameState.handler !== KrunkHandler.Terminal || aliceLogFiredRef.current) {
      return;
    }
    aliceLogFiredRef.current = true;
    onGameLog(
      formatKrunkHandLog(
        'alice',
        betSize,
        aliceHand.gameState.guesses,
        aliceHand.gameState.revealedWord ?? aliceHand.gameState.secretWord,
        formatAmount,
      ),
    );
  }, [
    aliceHand.gameState.handler,
    aliceHand.gameState.guesses,
    aliceHand.gameState.revealedWord,
    aliceHand.gameState.secretWord,
    betSize,
    formatAmount,
    onGameLog,
  ]);
  useEffect(() => {
    if (bobHand.gameState.handler !== KrunkHandler.Terminal || bobLogFiredRef.current) {
      return;
    }
    bobLogFiredRef.current = true;
    onGameLog(
      formatKrunkHandLog(
        'bob',
        betSize,
        bobHand.gameState.guesses,
        bobHand.gameState.revealedWord,
        formatAmount,
      ),
    );
  }, [
    bobHand.gameState.handler,
    bobHand.gameState.guesses,
    bobHand.gameState.revealedWord,
    betSize,
    formatAmount,
    onGameLog,
  ]);

  // Word picker gate: must commit secret word (alice side) before Bob input.
  const wordCommitted = aliceHand.gameState.secretWord !== null;
  const [wordDraft, setWordDraft] = useState('');
  const [guessDraft, setGuessDraft] = useState('');
  const [guessQueue, setGuessQueue] = useState<string[]>([]);

  // Resolved cells must receive their delay in the render where they mount:
  // LetterCell intentionally latches that initial delay.
  const prevResolvedCountRef = useRef(0);
  const resolvedCount = bobHand.gameState.guesses.filter(
    (g) => !g.clue.every((v) => v === -1n),
  ).length;
  const newlyResolvedIndex = newlyResolvedKrunkIndex(resolvedCount, prevResolvedCountRef.current);
  // Dictionary rejection rolls back the sent guess in gameState; hide any
  // still-queued rows in the same render (don't wait for the clear effect).
  const displayQueue = isKrunkDictionaryRejectionError(bobHand.gameState.error) ? [] : guessQueue;
  const displayedBobGuesses = krunkGuessesWithQueued(bobHand.gameState.guesses, displayQueue);
  const [animateIndex, setAnimateIndex] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (newlyResolvedIndex === undefined) return;
    prevResolvedCountRef.current = resolvedCount;
    setAnimateIndex(newlyResolvedIndex);
  }, [newlyResolvedIndex, resolvedCount]);
  const latestAnimateIndex = newlyResolvedIndex ?? animateIndex;

  const bobRevealedWord = bobHand.gameState.revealedWord;
  const bobSolved = bobHand.gameState.guesses.some((g) => g.clue.every((v) => v === 2n));
  const bobMissed = bobRevealedWord != null && !bobSolved;
  const animateBobReveal = bobMissed && latestAnimateIndex === bobHand.gameState.guesses.length - 1;
  // Wait for the final guess row to finish flipping before mounting the
  // answer row, so its flip starts only after that animation ends.
  const [bobRevealReady, setBobRevealReady] = useState(false);
  useEffect(() => {
    if (!bobMissed) {
      setBobRevealReady(false);
      return;
    }
    if (!animateBobReveal) {
      setBobRevealReady(true);
      return;
    }
    setBobRevealReady(false);
    const t = setTimeout(() => setBobRevealReady(true), GUESS_ROW_FLIP_MS);
    return () => clearTimeout(t);
  }, [bobMissed, animateBobReveal]);

  const bobGameOver = bobHand.gameState.handler === KrunkHandler.Terminal;
  const filledGuessCount = bobHand.gameState.guesses.length + displayQueue.length;
  const isBobGuessPhase =
    interactive &&
    bobInHand &&
    wordCommitted &&
    bobHand.gameState.role === 'bob' &&
    bobHand.gameState.handler === KrunkHandler.BobGuess;
  const canDraftGuess =
    interactive &&
    bobInHand &&
    canDraftKrunkGuess(wordCommitted, bobHand.gameState.handler, filledGuessCount);
  const canQueueGuess =
    interactive &&
    bobInHand &&
    canQueueKrunkGuess(wordCommitted, bobHand.gameState.handler, filledGuessCount);

  // Drain the queue whenever it becomes our turn to guess. Only pop after
  // we know submit will accept (BobGuess); otherwise a rejected submit
  // would silently drop the queued word.
  //
  // A dictionary rejection also lands in BobGuess — drop everything still
  // queued rather than auto-sending guesses that assumed the rejected word.
  useEffect(() => {
    if (!interactive) return;
    if (isKrunkDictionaryRejectionError(bobHand.gameState.error)) {
      if (guessQueue.length > 0) setGuessQueue([]);
      return;
    }
    if (!isBobGuessPhase || guessQueue.length === 0) return;
    if (bobHand.gameState.handler !== KrunkHandler.BobGuess) return;
    const next = guessQueue[0];
    setGuessQueue((rest) => rest.slice(1));
    submitBobGuessMove(next);
  }, [
    isBobGuessPhase,
    interactive,
    guessQueue,
    bobHand.gameState.handler,
    bobHand.gameState.error,
    submitBobGuessMove,
  ]);

  useEffect(() => {
    if (bobGameOver && guessQueue.length > 0) setGuessQueue([]);
  }, [bobGameOver, guessQueue.length]);

  const pickingWord = aliceInteractive && !wordCommitted;
  const showWordDraft = aliceInHand && !wordCommitted;
  // Prefer pick while the secret word is still needed; otherwise guess
  // whenever there is room to type/queue — including while BobWaiting on a clue.
  const keyboardMode: 'pick' | 'guess' | null = pickingWord
    ? 'pick'
    : canDraftGuess
      ? 'guess'
      : null;
  const activeDraft = keyboardMode === 'pick' ? wordDraft : guessDraft;
  const showGuessDraft = canDraftGuess || guessDraft.length > 0;
  const keyboardFocusRef = useRef<HTMLDivElement>(null);

  const commitWord = useCallback(() => {
    if (wordDraft.length !== 5) return false;
    setAliceSecretWord(wordDraft);
    setWordDraft('');
    return true;
  }, [wordDraft, setAliceSecretWord]);

  const submitGuess = useCallback(() => {
    if (guessDraft.length !== 5) return false;
    // Always allow queueing when not in a live send phase (waiting on
    // commit or clue). Send immediately only when it is our guess turn
    // and the queue is empty.
    if (isBobGuessPhase && guessQueue.length === 0) {
      submitBobGuessMove(guessDraft);
    } else if (canQueueGuess || (isBobGuessPhase && guessQueue.length > 0)) {
      if (filledGuessCount >= MAX_GUESSES) return false;
      setGuessQueue((prev) => [...prev, guessDraft]);
    } else {
      return false;
    }
    setGuessDraft('');
    return true;
  }, [
    guessDraft,
    isBobGuessPhase,
    canQueueGuess,
    guessQueue.length,
    filledGuessCount,
    submitBobGuessMove,
  ]);

  const submitActive = useCallback(() => {
    const submitted =
      keyboardMode === 'pick' ? commitWord() : keyboardMode === 'guess' ? submitGuess() : false;
    if (submitted) keyboardFocusRef.current?.focus();
  }, [keyboardMode, commitWord, submitGuess]);

  const themLabel = opponentName ?? 'Opponent';

  const handComplete =
    bobHand.gameState.handler === KrunkHandler.Terminal &&
    aliceHand.gameState.handler === KrunkHandler.Terminal;

  const bobBoardNotice = useMemo(
    () =>
      krunkBoardNotice(
        bobHand.gameState,
        themLabel,
        terminalsById[bobId],
        amountsById[bobId] ?? null,
      ),
    [bobHand.gameState, themLabel, terminalsById, amountsById, bobId],
  );

  const aliceBoardNotice = useMemo(
    () =>
      krunkBoardNotice(
        aliceHand.gameState,
        themLabel,
        terminalsById[aliceId],
        amountsById[aliceId] ?? null,
      ),
    [aliceHand.gameState, themLabel, terminalsById, amountsById, aliceId],
  );

  const sharedStatusNotice = useMemo(() => {
    if (handComplete) return { text: '', kind: 'info' };
    if (!wordCommitted) return { text: 'Pick your secret word', kind: 'info' };
    if (displayQueue.length > 0) {
      return {
        text:
          displayQueue.length === 1 ? '1 guess queued…' : `${displayQueue.length} guesses queued…`,
        kind: 'info',
      };
    }
    if (bobHand.gameState.handler === KrunkHandler.BobGuess) {
      return {
        text: `Guess ${bobHand.gameState.guesses.length + 1} of ${MAX_GUESSES}`,
        kind: 'info',
      };
    }
    if (aliceHand.gameState.handler === KrunkHandler.AliceClue) {
      return { text: 'Scoring…', kind: 'info' };
    }
    return { text: `Waiting for ${themLabel}…`, kind: 'info' };
  }, [
    aliceHand.gameState.handler,
    bobHand.gameState,
    handComplete,
    wordCommitted,
    displayQueue.length,
    themLabel,
  ]);

  const letterStatuses = useMemo(
    () => krunkLetterStatuses(bobHand.gameState.guesses),
    [bobHand.gameState.guesses],
  );

  const typeLetter = useCallback(
    (letter: string) => {
      if (keyboardMode === null) return;
      const setter = keyboardMode === 'pick' ? setWordDraft : setGuessDraft;
      setter((prev) => {
        if (prev.length >= 5) return prev;
        return (prev + letter.toUpperCase()).replace(/[^A-Z]/g, '').slice(0, 5);
      });
    },
    [keyboardMode],
  );

  const backspace = useCallback(() => {
    if (keyboardMode === null) return;
    const setter = keyboardMode === 'pick' ? setWordDraft : setGuessDraft;
    setter((prev) => prev.slice(0, -1));
  }, [keyboardMode]);

  // Physical keyboard for pick/guess drafting.
  useEffect(() => {
    if (!interactive) return;
    if (keyboardMode === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (activeDraft.length === 5) submitActive();
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        backspace();
        return;
      }
      if (/^[a-zA-Z]$/.test(e.key)) {
        e.preventDefault();
        typeLetter(e.key);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [interactive, keyboardMode, activeDraft, submitActive, backspace, typeLetter]);

  // Label tracks the next action the player needs, even while waiting.
  const actionLabel = !wordCommitted ? 'Pick' : 'Guess';
  const actionEnabled =
    keyboardMode === 'pick'
      ? wordDraft.length === 5
      : keyboardMode === 'guess' && guessDraft.length === 5 && (isBobGuessPhase || canQueueGuess);
  return (
    <div className="flex flex-col gap-4 items-center py-4">
      <div className="flex gap-6 items-start justify-center">
        {/* Left: Bob's guessing board (my guesses) */}
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm font-semibold text-canvas-text-contrast">Your guesses</p>
          <Grid
            guesses={displayedBobGuesses}
            draft={guessDraft}
            showDraftRow={showGuessDraft}
            latestAnimateIndex={latestAnimateIndex}
          />
          {bobMissed && bobRevealReady && bobRevealedWord ? (
            <TargetRow word={bobRevealedWord} animate={animateBobReveal} />
          ) : (
            <div className="flex gap-1 mt-2">
              {[0, 1, 2, 3, 4].map((i) => (
                <EmptyCell key={i} />
              ))}
            </div>
          )}
          <p
            className={`min-h-5 max-w-60 text-center text-xs ${
              bobBoardNotice?.kind === 'error'
                ? 'text-red-600'
                : bobBoardNotice?.kind === 'win'
                  ? 'font-semibold text-canvas-text-contrast'
                  : 'text-canvas-text-contrast'
            }`}
          >
            {bobBoardNotice?.text ?? ''}
          </p>
        </div>

        {/* Right: Alice's board (opponent guessing my word) */}
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm font-semibold text-canvas-text-contrast">
            {themLabel}&apos;s guesses
          </p>
          <Grid guesses={aliceHand.gameState.guesses} />

          {showWordDraft ? (
            <div className="flex gap-1 mt-2">
              {[0, 1, 2, 3, 4].map((i) => (
                <EmptyCell key={i} letter={wordDraft.charAt(i)} />
              ))}
            </div>
          ) : aliceHand.gameState.secretWord ? (
            <TargetRow word={aliceHand.gameState.secretWord} />
          ) : null}
          <p
            className={`min-h-5 max-w-60 text-center text-xs ${
              aliceBoardNotice?.kind === 'error' ? 'text-red-600' : 'text-canvas-text-contrast'
            }`}
          >
            {aliceBoardNotice?.text ?? ''}
          </p>
        </div>
      </div>

      <div
        ref={keyboardFocusRef}
        tabIndex={-1}
        className="flex flex-col items-center gap-2 focus:outline-none"
      >
        <OnScreenKeyboard
          statuses={letterStatuses}
          disabled={!interactive || keyboardMode === null || handComplete}
          onLetter={typeLetter}
          onBackspace={backspace}
        />
        <button
          type="button"
          className="px-4 py-1.5 rounded bg-primary-solid text-primary-on-primary text-sm font-medium hover:bg-primary-solid-hover disabled:opacity-40"
          disabled={!interactive || !actionEnabled || handComplete}
          onClick={submitActive}
        >
          {actionLabel}
        </button>
      </div>
      {sharedStatusNotice.text && (
        <p className="text-center text-sm text-canvas-text-contrast">{sharedStatusNotice.text}</p>
      )}
    </div>
  );
};

export default Krunk;
