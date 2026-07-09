import { useCallback, useEffect, useMemo, useState } from 'react';
import { Observable } from 'rxjs';
import { SessionController } from '../hooks/SessionController';
import {
  useKrunkHand,
  KrunkHandler,
  KrunkGuess,
} from '../hooks/useKrunkHand';
import { GameplayEvent } from '../hooks/useGameSession';

export interface KrunkProps {
  gameObject: SessionController;
  gameIds: string[];
  iStarted: boolean;
  gameplayEvent$: Observable<GameplayEvent>;
  betSize: bigint;
  onTurnChanged: (isMyTurn: boolean) => void;
  myName?: string;
  opponentName?: string;
}

const MAX_GUESSES = 5;
const TILE = 'w-12 h-12 text-xl';

function tileColor(value: number): string {
  if (value === 2) return 'bg-[#00875f] text-white border-[#00875f]';
  if (value === 1) return 'bg-[#e89f00] text-white border-[#e89f00]';
  if (value === 0) return 'bg-[#787c7e] text-white border-[#787c7e]';
  return 'bg-canvas-bg text-canvas-text-contrast border-canvas-line';
}

function LetterCell({ letter, clueValue }: { letter: string; clueValue: number }) {
  return (
    <div
      className={`inline-flex items-center justify-center rounded border font-bold uppercase tabular-nums select-none ${TILE} ${tileColor(clueValue)}`}
    >
      {letter}
    </div>
  );
}

function EmptyCell({ letter }: { letter?: string }) {
  return (
    <div className={`inline-flex items-center justify-center rounded border border-dashed border-canvas-line font-bold uppercase text-canvas-text-contrast ${TILE}`}>
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

function GuessRow({ guess }: { guess: KrunkGuess }) {
  return (
    <div className='flex gap-1'>
      {[0, 1, 2, 3, 4].map(i => (
        <LetterCell key={i} letter={guess.word.charAt(i)} clueValue={guess.clue[i]} />
      ))}
    </div>
  );
}

function Grid({
  guesses,
  draft,
  showDraftRow,
}: {
  guesses: KrunkGuess[];
  draft?: string;
  showDraftRow?: boolean;
}) {
  const draftLetters = (draft ?? '').split('').slice(0, 5);
  const rows = [];
  for (let i = 0; i < MAX_GUESSES; i++) {
    if (i < guesses.length) {
      rows.push(<GuessRow key={i} guess={guesses[i]} />);
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
  iStarted,
  gameplayEvent$,
  betSize: _betSize,
  onTurnChanged,
  myName,
  opponentName,
}) => {
  // In a krunk hand we always have two games: one where I'm Alice (I
  // started = I committed the word), one where I'm Bob (opponent
  // started = I guess). Derive which ID is which from the proposal
  // order: the first ID was proposed with my_turn=true (I'm Alice),
  // the second with my_turn=false (I'm Bob).
  const aliceGameId = gameIds[0] ?? '';
  const bobGameId = gameIds[1] ?? gameIds[0] ?? '';

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

  // Clear guess draft when a guess is recorded.
  useEffect(() => {
    if (bobHand.gameState.handler === KrunkHandler.BobGuess) {
      setGuessDraft('');
    }
  }, [bobHand.gameState.guesses.length, bobHand.gameState.handler]);

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
    if (guessDraft.length !== 5) return;
    bobHand.submitGuess(guessDraft);
  };

  const youLabel = myName ?? 'You';
  const themLabel = opponentName ?? 'Opponent';

  const isBobGuessPhase =
    wordCommitted &&
    bobHand.gameState.role === 'bob' &&
    bobHand.gameState.handler === KrunkHandler.BobGuess;

  const bobStatus = useMemo(() => {
    const gs = bobHand.gameState;
    if (gs.handler === KrunkHandler.Terminal) {
      if (gs.outcome === 'win') return 'You guessed it!';
      return `Out of guesses. Word was ${gs.revealedWord ?? '?????'}.`;
    }
    if (!wordCommitted) return 'Pick your word first →';
    if (gs.handler === KrunkHandler.BobGuess) {
      return `Guess ${gs.guesses.length + 1} of ${MAX_GUESSES}`;
    }
    return `Waiting for ${themLabel}…`;
  }, [bobHand.gameState, wordCommitted, themLabel]);

  const aliceStatus = useMemo(() => {
    const gs = aliceHand.gameState;
    if (gs.handler === KrunkHandler.Terminal) {
      if (gs.outcome === 'win') return `${themLabel} couldn't guess it!`;
      return `${themLabel} guessed your word.`;
    }
    if (gs.handler === KrunkHandler.WaitingCommit) return 'Pick your secret word';
    if (gs.handler === KrunkHandler.AliceClue) return 'Scoring…';
    return `Waiting for ${themLabel}…`;
  }, [aliceHand.gameState, themLabel]);

  return (
    <div className='flex flex-col gap-4 items-center py-4'>
      <div className='flex gap-6 items-start justify-center'>
        {/* Left: Bob's guessing board (my guesses) */}
        <div className='flex flex-col items-center gap-2'>
          <p className='text-sm font-semibold text-canvas-text-contrast'>
            Your guesses
          </p>
          <Grid
            guesses={bobHand.gameState.guesses}
            draft={guessDraft}
            showDraftRow={isBobGuessPhase}
          />

          {isBobGuessPhase && (
            <div className='flex flex-col items-center gap-2 mt-1'>
              <input
                type='text'
                inputMode='text'
                spellCheck={false}
                autoCapitalize='characters'
                className='w-40 rounded border border-canvas-line bg-canvas-bg px-2 py-1 text-center text-lg font-mono uppercase tracking-widest text-canvas-text-contrast focus:outline-none focus:ring-1 focus:ring-canvas-solid'
                value={guessDraft}
                placeholder='_____'
                onChange={e => onGuessDraftChange(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submitGuess(); }}
              />
              <button
                type='button'
                className='px-3 py-1.5 rounded bg-primary-solid text-primary-on-primary text-sm font-medium hover:bg-primary-solid-hover disabled:opacity-40'
                disabled={guessDraft.length !== 5}
                onClick={submitGuess}
              >
                Submit guess
              </button>
            </div>
          )}

          <p className='text-xs text-canvas-text mt-1'>{bobStatus}</p>
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

          {!wordCommitted && (
            <div className='flex flex-col items-center gap-2 mt-1'>
              <input
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
          )}

          <p className='text-xs text-canvas-text mt-1'>{aliceStatus}</p>
        </div>
      </div>
    </div>
  );
};

export default Krunk;
