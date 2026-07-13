import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Observable } from 'rxjs';
import { SessionController } from '../hooks/SessionController';
import {
  useKrunkHand,
  canDraftKrunkGuess,
  krunkGuessesWithQueued,
  krunkGuessSubmissionMode,
  KrunkHandler,
  KrunkGuess,
} from '../hooks/useKrunkHand';
import { GameplayEvent } from '../hooks/useGameSession';

export interface KrunkProps {
  gameObject: SessionController;
  gameIds: string[];
  iProposedHand: boolean;
  gameplayEvent$: Observable<GameplayEvent>;
  betSize: bigint;
  onTurnChanged: (isMyTurn: boolean) => void;
  myName?: string;
  opponentName?: string;
}

const MAX_GUESSES = 5;
const TILE = 'w-12 h-12 text-xl';
const FLIP_HALF_MS = 400;
const FLIP_STAGGER_MS = 200;

const CLUE_COLORS: Record<number, { bg: string; border: string }> = {
  2: { bg: '#00875f', border: '#00875f' },
  1: { bg: '#e89f00', border: '#e89f00' },
  0: { bg: '#787c7e', border: '#787c7e' },
};

function LetterCell({ letter, clueValue, flipDelay }: { letter: string; clueValue: number; flipDelay?: number }) {
  // 3 phases: 'idle' (neutral), 'half' (edge-on, swap color), 'done' (revealed)
  const animationDelay = useRef(flipDelay).current;
  const [phase, setPhase] = useState<'idle' | 'half' | 'done'>(animationDelay == null ? 'done' : 'idle');

  useEffect(() => {
    if (animationDelay == null) return;
    setPhase('idle');
    const start = setTimeout(() => setPhase('half'), animationDelay);
    return () => clearTimeout(start);
  }, [animationDelay]);

  useEffect(() => {
    if (phase !== 'half') return;
    const fallback = setTimeout(
      () => setPhase(current => current === 'half' ? 'done' : current),
      FLIP_HALF_MS + 100,
    );
    return () => clearTimeout(fallback);
  }, [phase]);

  const showColor = phase === 'done';
  const color = CLUE_COLORS[clueValue];
  const style: React.CSSProperties = {
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
      onTransitionEnd={event => {
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
    <div className={`inline-flex items-center justify-center rounded border border-dashed border-canvas-line bg-canvas-bg font-bold uppercase text-canvas-text-contrast ${TILE}`}>
      {letter ?? ''}
    </div>
  );
}

function TargetCell({ letter }: { letter: string }) {
  return (
    <div className={`inline-flex items-center justify-center rounded border border-[#999] bg-[#e0e0e0] text-black font-bold uppercase tabular-nums select-none ${TILE}`}>
      {letter}
    </div>
  );
}

function PendingGuessRow({ word }: { word: string }) {
  return (
    <div className='flex gap-1'>
      {[0, 1, 2, 3, 4].map(i => (
        <EmptyCell key={i} letter={word.charAt(i)} />
      ))}
    </div>
  );
}

function GuessRow({ guess, animate }: { guess: KrunkGuess; animate?: boolean }) {
  const pending = guess.clue.every(v => v === -1);
  if (pending) return <PendingGuessRow word={guess.word} />;
  return (
    <div className='flex gap-1'>
      {[0, 1, 2, 3, 4].map(i => (
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
        <div key={i} className='flex gap-1'>
          {[0, 1, 2, 3, 4].map(j => (
            <EmptyCell key={j} letter={draftLetters[j]} />
          ))}
        </div>,
      );
    } else {
      rows.push(
        <div key={i} className='flex gap-1'>
          {[0, 1, 2, 3, 4].map(j => <EmptyCell key={j} />)}
        </div>,
      );
    }
  }
  return <div className='flex flex-col gap-1 items-center'>{rows}</div>;
}

function TargetRow({ word }: { word: string }) {
  return (
    <div className='flex gap-1 mt-2'>
      {[0, 1, 2, 3, 4].map(i => (
        <TargetCell key={i} letter={word.charAt(i)} />
      ))}
    </div>
  );
}

const Krunk: React.FC<KrunkProps> = ({
  gameObject,
  gameIds,
  iProposedHand,
  gameplayEvent$,
  betSize: _betSize,
  onTurnChanged,
  myName,
  opponentName,
}) => {
  // The hand proposer sent game 0 with my_turn=true (proposer is alice)
  // and game 1 with my_turn=false (proposer is bob). The acceptor's
  // roles are flipped: they're bob in game 0 and alice in game 1.
  const aliceGameId = iProposedHand ? (gameIds[0] ?? '') : (gameIds[1] ?? gameIds[0] ?? '');
  const bobGameId = iProposedHand ? (gameIds[1] ?? gameIds[0] ?? '') : (gameIds[0] ?? '');

  // useKrunkHand maps iStarted → role: iStarted=true means bob, false means alice.
  // Alice game (I pick the word): iStarted=false → role='alice'.
  // Bob game (I guess): iStarted=true → role='bob'.
  const aliceHand = useKrunkHand(
    gameObject,
    aliceGameId,
    false,
    gameplayEvent$,
    useCallback(() => {}, []),
  );

  const bobHand = useKrunkHand(
    gameObject,
    bobGameId,
    true,
    gameplayEvent$,
    useCallback(() => {}, []),
  );

  // Report turn state: either game needing input = my turn.
  useEffect(() => {
    const myTurn = aliceHand.gameState.myTurn || bobHand.gameState.myTurn;
    onTurnChanged(myTurn);
  }, [aliceHand.gameState.myTurn, bobHand.gameState.myTurn, onTurnChanged]);

  // Word picker gate: must commit secret word (alice side) before Bob input.
  const wordCommitted = aliceHand.gameState.handler !== KrunkHandler.WaitingCommit;
  const [wordDraft, setWordDraft] = useState('');
  const [guessDraft, setGuessDraft] = useState('');
  const [queuedGuess, setQueuedGuess] = useState<string | null>(null);

  const wordInputRef = useRef<HTMLInputElement>(null);
  const guessInputRef = useRef<HTMLInputElement>(null);

  // Track the index of the most recently resolved guess for animation.
  // Detect new clues synchronously to avoid a flash frame, but persist
  // the value in state so it survives re-renders while the animation plays.
  const prevResolvedCountRef = useRef(0);
  const resolvedCount = bobHand.gameState.guesses.filter(g => !g.clue.every(v => v === -1)).length;
  const displayedBobGuesses = krunkGuessesWithQueued(
    bobHand.gameState.guesses,
    queuedGuess,
  );
  const [animateIndex, setAnimateIndex] = useState<number | undefined>(undefined);
  if (resolvedCount > prevResolvedCountRef.current) {
    prevResolvedCountRef.current = resolvedCount;
    setAnimateIndex(resolvedCount - 1);
  }

  // Auto-focus word input on mount.
  useEffect(() => {
    if (!wordCommitted) {
      wordInputRef.current?.focus();
    }
  }, [wordCommitted]);

  // Auto-focus guess input when guess phase starts.
  const isBobGuessPhase =
    wordCommitted &&
    bobHand.gameState.role === 'bob' &&
    bobHand.gameState.handler === KrunkHandler.BobGuess;
  const canDraftFirstGuess = canDraftKrunkGuess(
    wordCommitted,
    bobHand.gameState.handler,
    bobHand.gameState.guesses.length,
  );
  const guessSubmissionMode = krunkGuessSubmissionMode(
    isBobGuessPhase,
    canDraftFirstGuess && queuedGuess === null,
  );

  useEffect(() => {
    if (isBobGuessPhase) {
      guessInputRef.current?.focus();
    }
  }, [isBobGuessPhase]);

  useEffect(() => {
    if (canDraftFirstGuess) {
      guessInputRef.current?.focus();
    }
  }, [canDraftFirstGuess]);

  useEffect(() => {
    if (!isBobGuessPhase || queuedGuess === null) return;
    bobHand.submitGuess(queuedGuess);
    setQueuedGuess(null);
  }, [isBobGuessPhase, queuedGuess, bobHand.submitGuess]);

  const bobGameOver = bobHand.gameState.handler === KrunkHandler.Terminal;

  const onWordDraftChange = (raw: string) => {
    setWordDraft(raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5));
  };

  const onGuessDraftChange = (raw: string) => {
    setGuessDraft(raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5));
  };

  const commitWord = () => {
    if (wordDraft.length !== 5) return;
    aliceHand.setSecretWord(wordDraft);
    setWordDraft('');
  };

  const submitGuess = () => {
    if (guessDraft.length !== 5 || guessSubmissionMode === null) return;
    if (guessSubmissionMode === 'queue') {
      setQueuedGuess(guessDraft);
    } else {
      bobHand.submitGuess(guessDraft);
    }
    setGuessDraft('');
  };

  const themLabel = opponentName ?? 'Opponent';

  const bobStatus = useMemo(() => {
    const gs = bobHand.gameState;
    if (gs.handler === KrunkHandler.Terminal) {
      if (gs.outcome === 'win') return 'You guessed it!';
      return `Out of guesses. Word was ${gs.revealedWord ?? '?????'}.`;
    }
    if (gs.error) return gs.error;
    if (!wordCommitted) return 'Pick your word first →';
    if (queuedGuess !== null) return 'First guess queued…';
    if (gs.handler === KrunkHandler.BobGuess) {
      return `Guess ${gs.guesses.length + 1} of ${MAX_GUESSES}`;
    }
    return `Waiting for ${themLabel}…`;
  }, [bobHand.gameState, wordCommitted, queuedGuess, themLabel]);

  const aliceStatus = useMemo(() => {
    const gs = aliceHand.gameState;
    if (gs.handler === KrunkHandler.Terminal) {
      if (gs.outcome === 'win') return `${themLabel} couldn't guess it!`;
      return `${themLabel} guessed your word.`;
    }
    if (gs.error) return gs.error;
    if (gs.handler === KrunkHandler.WaitingCommit) return 'Pick your secret word';
    if (gs.handler === KrunkHandler.AliceClue) return 'Scoring…';
    return `Waiting for ${themLabel}…`;
  }, [aliceHand.gameState, themLabel]);

  const guessInputDisabled = guessSubmissionMode === null;
  const showGuessInput = wordCommitted && !bobGameOver;

  return (
    <div className='flex flex-col gap-4 items-center py-4'>
      <div className='flex gap-6 items-start justify-center'>
        {/* Left: Bob's guessing board (my guesses) */}
        <div className='flex flex-col items-center gap-2'>
          <p className='text-sm font-semibold text-canvas-text-contrast'>
            Your guesses
          </p>
          <Grid
            guesses={displayedBobGuesses}
            draft={guessDraft}
            showDraftRow={showGuessInput && queuedGuess === null}
            latestAnimateIndex={animateIndex}
          />

          <div className={`flex flex-col items-center gap-2 mt-1 ${showGuessInput ? '' : 'hidden'}`}>
            <input
              ref={guessInputRef}
              type='text'
              inputMode='text'
              spellCheck={false}
              autoCapitalize='characters'
              className='w-40 rounded border border-canvas-line bg-canvas-bg px-2 py-1 text-center text-lg font-mono uppercase tracking-widest text-canvas-text-contrast focus:outline-none focus:ring-1 focus:ring-canvas-solid disabled:opacity-40 disabled:cursor-not-allowed'
              value={guessDraft}
              placeholder='_____'
              disabled={guessInputDisabled}
              onChange={e => onGuessDraftChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && guessSubmissionMode !== null) submitGuess(); }}
            />
            <button
              type='button'
              className='px-3 py-1.5 rounded bg-primary-solid text-primary-on-primary text-sm font-medium hover:bg-primary-solid-hover disabled:opacity-40'
              disabled={guessSubmissionMode === null || guessDraft.length !== 5}
              onClick={submitGuess}
            >
              Submit guess
            </button>
          </div>

          <p className={`text-xs mt-1 ${bobHand.gameState.error ? 'text-red-600' : 'text-canvas-text'}`}>
            {bobStatus}
          </p>
        </div>

        {/* Right: Alice's board (opponent guessing my word) */}
        <div className='flex flex-col items-center gap-2'>
          <p className='text-sm font-semibold text-canvas-text-contrast'>
            {themLabel}&apos;s guesses
          </p>
          <Grid guesses={aliceHand.gameState.guesses} />

          {aliceHand.gameState.secretWord && (
            <TargetRow word={aliceHand.gameState.secretWord} />
          )}

          <div className={`flex flex-col items-center gap-2 mt-1 ${wordCommitted ? 'hidden' : ''}`}>
            <input
              ref={wordInputRef}
              type='text'
              inputMode='text'
              spellCheck={false}
              autoCapitalize='characters'
              className='w-40 rounded border border-canvas-line bg-canvas-bg px-2 py-1 text-center text-lg font-mono uppercase tracking-widest text-canvas-text-contrast focus:outline-none focus:ring-1 focus:ring-canvas-solid'
              value={wordDraft}
              placeholder='_____'
              onChange={e => onWordDraftChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') commitWord(); }}
            />
            <button
              type='button'
              className='px-3 py-1.5 rounded bg-primary-solid text-primary-on-primary text-sm font-medium hover:bg-primary-solid-hover disabled:opacity-40'
              disabled={wordDraft.length !== 5}
              onClick={commitWord}
            >
              Commit secret word
            </button>
          </div>

          <p className={`text-xs mt-1 ${aliceHand.gameState.error ? 'text-red-600' : 'text-canvas-text'}`}>
            {aliceStatus}
          </p>
        </div>
      </div>
    </div>
  );
};

export default Krunk;
