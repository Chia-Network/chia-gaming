import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Observable } from 'rxjs';
import { formatMojos } from '../util';
import { WasmBlobWrapper } from '../hooks/WasmBlobWrapper';
import {
  useKrunkHand,
  KrunkHandler,
  KrunkGuess,
} from '../hooks/useKrunkHand';
import { GameplayEvent } from '../hooks/useGameSession';

interface KrunkProps {
  gameObject: WasmBlobWrapper;
  gameId: string;
  iStarted: boolean;
  gameplayEvent$: Observable<GameplayEvent>;
  betSize: bigint;
  onTurnChanged: (isMyTurn: boolean) => void;
  myName?: string;
  opponentName?: string;
}

const MAX_GUESSES = 5;

function letterCellClass(value: number): string {
  // -1 = pending (no clue yet), 0 = absent, 1 = wrong slot, 2 = correct.
  if (value === 2) return 'bg-emerald-600 text-white border-emerald-700';
  if (value === 1) return 'bg-amber-500 text-white border-amber-600';
  if (value === 0) return 'bg-zinc-600 text-white border-zinc-700';
  return 'bg-canvas-bg text-canvas-text-contrast border-canvas-line';
}

function LetterCell({
  letter,
  clueValue,
  size,
}: {
  letter: string;
  clueValue: number;
  size?: 'lg' | 'sm';
}) {
  const dim = size === 'sm' ? 'w-8 h-8 text-base' : 'w-12 h-12 text-xl';
  return (
    <div
      className={`inline-flex items-center justify-center rounded border font-bold uppercase tabular-nums select-none ${dim} ${letterCellClass(
        clueValue,
      )}`}
    >
      {letter}
    </div>
  );
}

function GuessRow({ guess }: { guess: KrunkGuess }) {
  return (
    <div className='flex gap-1'>
      {[0, 1, 2, 3, 4].map((i) => (
        <LetterCell
          key={i}
          letter={guess.word.charAt(i)}
          clueValue={guess.clue[i]}
        />
      ))}
    </div>
  );
}

function EmptyRow({ draftLetters }: { draftLetters?: string[] }) {
  return (
    <div className='flex gap-1'>
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className='inline-flex items-center justify-center rounded border border-dashed border-canvas-line w-12 h-12 text-xl font-bold uppercase text-canvas-text-contrast'
        >
          {draftLetters ? draftLetters[i] ?? '' : ''}
        </div>
      ))}
    </div>
  );
}

function GuessGrid({
  guesses,
  draft,
  showDraftRow,
}: {
  guesses: KrunkGuess[];
  draft: string;
  showDraftRow: boolean;
}) {
  const draftLetters = draft.split('').slice(0, 5);
  const rows: ReactElement[] = [];
  for (let i = 0; i < MAX_GUESSES; i++) {
    if (i < guesses.length) {
      rows.push(<GuessRow key={i} guess={guesses[i]} />);
    } else if (showDraftRow && i === guesses.length) {
      rows.push(<EmptyRow key={i} draftLetters={draftLetters} />);
    } else {
      rows.push(<EmptyRow key={i} />);
    }
  }
  return <div className='flex flex-col gap-1 items-center'>{rows}</div>;
}

function StatusLine({
  prefix,
  text,
}: {
  prefix: string;
  text: string;
}) {
  return (
    <p className='text-sm text-canvas-text-contrast'>
      <span className='font-semibold mr-1'>{prefix}</span>
      {text}
    </p>
  );
}

const Krunk: React.FC<KrunkProps> = ({
  gameObject,
  gameId,
  iStarted,
  gameplayEvent$,
  betSize,
  onTurnChanged,
  myName,
  opponentName,
}) => {
  const { gameState, setSecretWord, submitGuess } = useKrunkHand(
    gameObject,
    gameId,
    iStarted,
    gameplayEvent$,
    onTurnChanged,
  );

  // Alice-side: typing her secret word.
  const [aliceDraft, setAliceDraft] = useState('');
  // Bob-side: typing his current guess.
  const [bobDraft, setBobDraft] = useState('');

  // Clear bob's draft when his guess gets recorded into the grid.
  useEffect(() => {
    if (gameState.role === 'bob' && gameState.handler === KrunkHandler.BobGuess) {
      setBobDraft('');
    }
  }, [gameState.handler, gameState.role, gameState.guesses.length]);

  const youLabel = myName ?? 'You';
  const themLabel = opponentName ?? 'Opponent';

  const status = useMemo<string>(() => {
    if (gameState.handler === KrunkHandler.Terminal) {
      if (gameState.outcome === 'win') {
        return gameState.role === 'alice'
          ? `${themLabel} ran out of guesses. You won!`
          : `You guessed it! You won.`;
      }
      return gameState.role === 'alice'
        ? `${themLabel} guessed your word. You lost.`
        : `Out of guesses. The word was ${gameState.revealedWord ?? '?????'}.`;
    }
    if (gameState.role === 'alice') {
      if (gameState.handler === KrunkHandler.WaitingCommit) {
        return 'Pick a 5-letter secret word from the dictionary.';
      }
      if (gameState.handler === KrunkHandler.AliceClue) {
        return 'Scoring guess…';
      }
      return `Waiting for ${themLabel} to guess…`;
    }
    // Bob.
    if (gameState.handler === KrunkHandler.BobGuess) {
      return `Type a 5-letter guess. ${MAX_GUESSES - gameState.guesses.length} left.`;
    }
    return `Waiting for ${themLabel}…`;
  }, [gameState, themLabel]);

  const isAliceCommit =
    gameState.role === 'alice' && gameState.handler === KrunkHandler.WaitingCommit;
  const isBobGuess =
    gameState.role === 'bob' && gameState.handler === KrunkHandler.BobGuess;

  const onAliceDraftChange = (raw: string) => {
    const cleaned = raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
    setAliceDraft(cleaned);
  };

  const onBobDraftChange = (raw: string) => {
    const cleaned = raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
    setBobDraft(cleaned);
  };

  const submitAlice = () => {
    if (aliceDraft.length !== 5) return;
    setSecretWord(aliceDraft);
    setAliceDraft('');
  };

  const submitBob = () => {
    if (bobDraft.length !== 5) return;
    submitGuess(bobDraft);
  };

  return (
    <div className='flex flex-col gap-4 items-center py-4'>
      <div className='flex flex-col items-center gap-1'>
        <p className='text-xs uppercase tracking-widest text-canvas-text'>
          {themLabel}
        </p>
        <p className='text-[11px] text-canvas-text'>
          Krunk · stake {formatMojos(betSize)} per player
        </p>
      </div>

      <GuessGrid
        guesses={gameState.guesses}
        draft={bobDraft}
        showDraftRow={isBobGuess}
      />

      {isAliceCommit && (
        <div className='flex flex-col items-center gap-2'>
          <input
            type='text'
            inputMode='text'
            spellCheck={false}
            autoCapitalize='characters'
            className='w-40 rounded border border-canvas-line bg-canvas-bg px-2 py-1 text-center text-lg font-mono uppercase tracking-widest text-canvas-text-contrast focus:outline-none focus:ring-1 focus:ring-canvas-solid'
            value={aliceDraft}
            placeholder='_____'
            onChange={(e) => onAliceDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitAlice();
            }}
          />
          <button
            type='button'
            className='px-3 py-1.5 rounded bg-primary-solid text-primary-on-primary text-sm font-medium hover:bg-primary-solid-hover disabled:opacity-40'
            disabled={aliceDraft.length !== 5}
            onClick={submitAlice}
          >
            Commit secret word
          </button>
        </div>
      )}

      {isBobGuess && (
        <div className='flex flex-col items-center gap-2'>
          <input
            type='text'
            inputMode='text'
            spellCheck={false}
            autoCapitalize='characters'
            className='w-40 rounded border border-canvas-line bg-canvas-bg px-2 py-1 text-center text-lg font-mono uppercase tracking-widest text-canvas-text-contrast focus:outline-none focus:ring-1 focus:ring-canvas-solid'
            value={bobDraft}
            placeholder='_____'
            onChange={(e) => onBobDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitBob();
            }}
          />
          <button
            type='button'
            className='px-3 py-1.5 rounded bg-primary-solid text-primary-on-primary text-sm font-medium hover:bg-primary-solid-hover disabled:opacity-40'
            disabled={bobDraft.length !== 5}
            onClick={submitBob}
          >
            Submit guess
          </button>
        </div>
      )}

      {gameState.role === 'alice' && gameState.secretWord && (
        <p className='text-xs text-canvas-text'>
          Your word: <span className='font-mono font-bold'>{gameState.secretWord}</span>
        </p>
      )}

      <StatusLine prefix={`${youLabel}:`} text={status} />
    </div>
  );
};

export default Krunk;
