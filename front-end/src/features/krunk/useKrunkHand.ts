import { useState, useEffect, useCallback, useRef } from 'react';
import { Program } from 'clvm-lib';
import { Observable } from 'rxjs';
import { SessionController } from '../../hooks/SessionController';
import { GameplayEvent } from '../../hooks/useGameSession';
import { krunkSettlementStatus } from '../../lib/settlement';
import type { GameTerminalModel } from '../../lib/session/types';
import { krunkOutcomeFromPlay, reduceKrunkFeatureState } from './adapter';
import {
  krunkGameStateFromPersisted,
  KrunkHandler,
  type KrunkGameState,
  type KrunkGuess,
  type KrunkRole,
} from './stateCodec';
import type { PersistedGameState } from '../../lib/session/gameStateCodec';

export { KrunkHandler };
export type { KrunkGameState, KrunkGuess, KrunkRole };

export interface UseKrunkHandResult {
  gameState: KrunkGameState;
  setSecretWord: (word: string) => void;
  submitGuess: (word: string) => void;
}

const MAX_KRUNK_GUESSES = 5;

/** True while the guesser can type (send now or add to the queue). */
export function canDraftKrunkGuess(
  wordCommitted: boolean,
  handler: KrunkHandler,
  filledCount: number,
): boolean {
  // Any non-terminal bob state: BobWaiting (incl. waiting on commit/clue)
  // or BobGuess (our turn to send).
  if (!wordCommitted || filledCount >= MAX_KRUNK_GUESSES) return false;
  return handler === KrunkHandler.BobWaiting || handler === KrunkHandler.BobGuess;
}

/** True while guesses should be queued (waiting on commit/clue), not sent. */
export function canQueueKrunkGuess(
  wordCommitted: boolean,
  handler: KrunkHandler,
  filledCount: number,
): boolean {
  // Queue while waiting — both before opponent commit and while a clue is
  // outstanding after we already sent a guess.
  return wordCommitted && handler === KrunkHandler.BobWaiting && filledCount < MAX_KRUNK_GUESSES;
}

export function krunkGuessSubmissionMode(
  isGuessPhase: boolean,
  canQueue: boolean,
): 'send' | 'queue' | null {
  if (isGuessPhase) return 'send';
  if (canQueue) return 'queue';
  return null;
}

const PENDING_CLUE: KrunkGuess['clue'] = [-1n, -1n, -1n, -1n, -1n];

export function krunkGuessesWithQueued(
  guesses: KrunkGuess[],
  queuedGuesses: readonly string[],
): KrunkGuess[] {
  if (queuedGuesses.length === 0) return guesses;
  return [...guesses, ...queuedGuesses.map((word) => ({ word, clue: PENDING_CLUE }))];
}

/** True when gameState.error is a dictionary rejection (drop later queued guesses). */
export function isKrunkDictionaryRejectionError(error: string | null): boolean {
  return error != null && error.endsWith(' is not in the dictionary.');
}

export function applyKrunkMoveRejected(
  state: KrunkGameState,
  rejection: { tag: string; message: string },
): KrunkGameState {
  if (rejection.tag !== 'not_in_dictionary') return state;
  const word = rejection.message.toUpperCase();
  const error = `${word} is not in the dictionary.`;

  if (
    state.role === 'alice' &&
    state.handler === KrunkHandler.AliceWaiting &&
    state.secretWord === word
  ) {
    return {
      ...state,
      handler: KrunkHandler.WaitingCommit,
      myTurn: true,
      secretWord: null,
      error,
    };
  }

  const lastGuess = state.guesses[state.guesses.length - 1];
  if (
    state.role === 'bob' &&
    state.handler === KrunkHandler.BobWaiting &&
    lastGuess?.word === word &&
    lastGuess.clue.every((value) => value === -1n)
  ) {
    return {
      ...state,
      handler: KrunkHandler.BobGuess,
      myTurn: true,
      guesses: state.guesses.slice(0, -1),
      error,
    };
  }

  return state;
}

export interface KrunkBoardNotice {
  text: string;
  kind: 'error' | 'win' | 'info';
}

function krunkTerminalNotice(
  state: KrunkGameState,
  opponentLabel: string,
  terminal: GameTerminalModel,
  gameAmount: string | null,
): KrunkBoardNotice | null {
  if (state.handler !== KrunkHandler.Terminal) return null;
  if (terminal.outcome != null) {
    const clean =
      terminal.outcome === 'accept_settlement' ||
      terminal.outcome === 'we_accepted' ||
      terminal.outcome === 'settled_cleanly';
    if (!clean) {
      return { text: krunkSettlementStatus(terminal.outcome, opponentLabel), kind: 'info' };
    }
    const outcome = state.outcome ?? krunkOutcomeFromPlay(state);
    const ourShare = terminal.myReward === null ? null : BigInt(terminal.myReward);
    const amount = gameAmount === null ? null : BigInt(gameAmount);
    const winnerAmount =
      outcome === 'win'
        ? ourShare
        : outcome === 'lose' && ourShare !== null && amount !== null && amount >= ourShare
          ? amount - ourShare
          : null;
    if (outcome === 'win') {
      if (state.role === 'alice') {
        return { text: `${opponentLabel} didn't win anything.`, kind: 'info' };
      }
      return {
        text: winnerAmount === null ? 'You won!' : krunkWinMessage(winnerAmount.toString()),
        kind: 'win',
      };
    }
    if (outcome === 'lose') {
      if (state.role === 'bob') {
        return { text: "You didn't win anything.", kind: 'info' };
      }
      return {
        text:
          winnerAmount === null
            ? `${opponentLabel} won.`
            : krunkWinnerMessage(opponentLabel, winnerAmount.toString()),
        kind: 'info',
      };
    }
    return { text: 'Result unavailable.', kind: 'info' };
  }
  if (state.outcome === 'win' && state.moverShare !== null && BigInt(state.moverShare) > 0n) {
    return { text: krunkWinMessage(state.moverShare), kind: 'win' };
  }
  if (state.role === 'bob') {
    return { text: 'Out of guesses.', kind: 'info' };
  }
  return {
    text:
      state.outcome === 'win'
        ? `${opponentLabel} couldn't guess it!`
        : `${opponentLabel} guessed your word.`,
    kind: 'info',
  };
}

export function krunkTerminalStatus(
  state: KrunkGameState,
  opponentLabel: string,
  terminal: GameTerminalModel,
  gameAmount: string | null = null,
): string | null {
  return krunkTerminalNotice(state, opponentLabel, terminal, gameAmount)?.text ?? null;
}

export function krunkBoardNotice(
  state: KrunkGameState,
  opponentLabel: string,
  terminal: GameTerminalModel,
  gameAmount: string | null = null,
): KrunkBoardNotice | null {
  if (state.error) return { text: state.error, kind: 'error' };
  return krunkTerminalNotice(state, opponentLabel, terminal, gameAmount);
}

/** Win banner copy: mojo below 1e6, chia at/above (same crossover as formatAmount). */
export function krunkWinMessage(moverShare: string): string {
  return krunkWinnerMessage('You', moverShare);
}

export function krunkWinnerMessage(winner: string, amount: string): string {
  const mojos = BigInt(amount);
  if (mojos < 1_000_000n) {
    return `${winner} won ${mojos} mojo!`;
  }
  const TRILLION = 1_000_000_000_000n;
  const whole = mojos / TRILLION;
  const frac = mojos % TRILLION;
  if (frac === 0n) return `${winner} won ${whole} chia!`;
  const fracStr = frac.toString().padStart(12, '0').replace(/0+$/, '');
  return `${winner} won ${whole}.${fracStr} chia!`;
}

const MAX_GUESSES = 5;

function wordToProgram(word: string): Program {
  // Krunk handlers receive `local_move` as a single CLVM atom: the
  // word bytes. Program.fromBytes wraps a buffer as a single atom.
  return Program.fromBytes(new TextEncoder().encode(word.toUpperCase()));
}

export function useKrunkHand(
  _gameObject: SessionController,
  _gameId: string,
  iStarted: boolean,
  gameplayEvent$: Observable<GameplayEvent>,
  onTurnChanged: (isMyTurn: boolean) => void,
  active = true,
  initialPersistedState?: PersistedGameState,
): UseKrunkHandResult {
  // Channel-level convention: iStarted=true → I'm second mover in
  // every game. Krunk's first mover is alice (the committer), so the
  // channel initiator plays bob and the receiver plays alice.
  const role: KrunkRole = iStarted ? 'bob' : 'alice';

  const initialState = krunkGameStateFromPersisted(initialPersistedState, _gameId, role);
  const [gs, setGs] = useState<KrunkGameState>(initialState);

  const gsRef = useRef(gs);
  const gameObjectRef = useRef(_gameObject);
  const gameIdRef = useRef(_gameId);
  const handFinishedRef = useRef(false);
  const activeRef = useRef(active);

  gsRef.current = gs;
  gameObjectRef.current = _gameObject;
  gameIdRef.current = _gameId;
  activeRef.current = active;

  useEffect(() => {
    if (!_gameId) return;
    if (!active) {
      handFinishedRef.current = true;
      return;
    }
    // Clear a stale finished latch if the hand is live again and we have not
    // actually reached Terminal (guards against transient active=false gaps).
    if (gsRef.current.handler !== KrunkHandler.Terminal) {
      handFinishedRef.current = false;
    }
  }, [_gameId, active]);

  const projectState = useCallback(
    (next: KrunkGameState) => {
      gsRef.current = next;
      setGs(next);
      onTurnChanged(next.myTurn);
    },
    [onTurnChanged],
  );

  const transition = useCallback(
    (next: KrunkGameState) => {
      if (gameIdRef.current) {
        gameObjectRef.current.transitionFeatureState('krunk', gameIdRef.current, next);
      }
      projectState(next);
    },
    [projectState],
  );

  const finishGame = useCallback(
    (
      revealedWord: string | null,
      lastClue: KrunkGuess['clue'] | null,
      moverShare: string | null = null,
    ) => {
      const cur = gsRef.current;
      handFinishedRef.current = true;
      // Outcome from local POV: alice wins if bob never guessed correctly
      // (all clues != all-2s), bob wins if he guessed correctly.
      const correct = (c: KrunkGuess['clue']) => c.every((v) => v === 2n);
      const bobGuessedCorrectly =
        cur.guesses.some((g) => correct(g.clue)) || (lastClue !== null && correct(lastClue));
      const aliceWon = !bobGuessedCorrectly;
      transition({
        ...cur,
        handler: KrunkHandler.Terminal,
        myTurn: false,
        revealedWord,
        moverShare,
        outcome:
          (cur.role === 'alice' && aliceWon) || (cur.role === 'bob' && !aliceWon) ? 'win' : 'lose',
      });
    },
    [transition],
  );

  // ── OpponentMoved handling ──
  useEffect(() => {
    const sub = gameplayEvent$.subscribe({
      next: (evt: GameplayEvent) => {
        if ('OpponentMoved' in evt) {
          const evtGameId = evt.OpponentMoved.gameId;
          if (evtGameId && evtGameId !== gameIdRef.current) return;
          if (handFinishedRef.current) return;
          const next = reduceKrunkFeatureState(gsRef.current, {
            type: 'opponent-moved',
            readable: Uint8Array.from(evt.OpponentMoved.readable),
            moverShare: evt.OpponentMoved.moverShare,
          });
          if (next.handler === KrunkHandler.Terminal) handFinishedRef.current = true;
          projectState(next);
        } else if ('MoveRejected' in evt) {
          if (evt.MoveRejected.gameId !== gameIdRef.current) return;
          if (handFinishedRef.current) return;
          const next = applyKrunkMoveRejected(gsRef.current, evt.MoveRejected);
          if (next !== gsRef.current) {
            transition(next);
          }
        } else if ('Settled' in evt) {
          if (evt.Settled.gameId !== gameIdRef.current) return;
          handFinishedRef.current = true;
          projectState(reduceKrunkFeatureState(gsRef.current, { type: 'settled' }));
        } else if ('GameError' in evt) {
          if (evt.GameError.gameId !== gameIdRef.current) return;
          if (!handFinishedRef.current) {
            finishGame(gsRef.current.revealedWord, null);
          }
        }
      },
    });
    return () => sub.unsubscribe();
  }, [gameplayEvent$, transition, finishGame, projectState]);

  // ── Auto-play ──
  // Alice's `krunk_alice_handler_clue` decides internally whether to
  // send a clue or the final reveal. The user has nothing to choose;
  // we just feed it nil.
  useEffect(() => {
    if (
      !activeRef.current ||
      gs.role !== 'alice' ||
      gs.handler !== KrunkHandler.AliceClue ||
      !gs.myTurn
    )
      return;
    const go = gameObjectRef.current;
    const gid = gameIdRef.current;
    if (!activeRef.current || !go || !gid) return;
    try {
      const latest = gs.guesses[gs.guesses.length - 1];
      const isReveal =
        !!latest && (latest.clue.every((v) => v === 2n) || gs.guesses.length >= MAX_GUESSES);
      if (isReveal) {
        finishGame(gs.secretWord, latest.clue);
      } else {
        transition({ ...gs, handler: KrunkHandler.AliceWaiting, myTurn: false });
      }
      go.makeMove(gid, null);
    } catch (e) {
      console.error('[krunk] alice auto-clue failed', e);
      transition({
        ...gs,
        error: e instanceof Error ? e.message : String(e),
        myTurn: false,
      });
    }
  }, [gs, transition, finishGame]);

  const setSecretWord = useCallback(
    (word: string) => {
      const go = gameObjectRef.current;
      const gid = gameIdRef.current;
      const cur = gsRef.current;
      if (!activeRef.current || !go || !gid) return;
      if (cur.role !== 'alice' || cur.handler !== KrunkHandler.WaitingCommit) return;
      const normalised = word.trim().toUpperCase();
      if (!/^[A-Z]{5}$/.test(normalised)) {
        console.warn('[krunk] secret word must be 5 letters');
        return;
      }
      try {
        transition({
          ...cur,
          secretWord: normalised,
          handler: KrunkHandler.AliceWaiting,
          myTurn: false,
          error: null,
        });
        go.makeMove(gid, wordToProgram(normalised));
      } catch (e) {
        console.error('[krunk] commit failed', e);
        transition({
          ...cur,
          handler: KrunkHandler.WaitingCommit,
          myTurn: true,
          secretWord: null,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [transition],
  );

  const submitGuess = useCallback(
    (word: string) => {
      const go = gameObjectRef.current;
      const gid = gameIdRef.current;
      const cur = gsRef.current;
      if (!activeRef.current || !go || !gid) return;
      if (cur.role !== 'bob' || cur.handler !== KrunkHandler.BobGuess) return;
      const normalised = word.trim().toUpperCase();
      if (!/^[A-Z]{5}$/.test(normalised)) {
        console.warn('[krunk] guess must be 5 letters');
        return;
      }
      try {
        transition({
          ...cur,
          guesses: [
            ...cur.guesses,
            // Use -1 as a "pending" sentinel; replaced when alice's
            // clue readable arrives.
            { word: normalised, clue: PENDING_CLUE },
          ],
          handler: KrunkHandler.BobWaiting,
          myTurn: false,
          error: null,
        });
        go.makeMove(gid, wordToProgram(normalised));
      } catch (e) {
        console.error('[krunk] guess failed', e);
        transition({
          ...cur,
          handler: KrunkHandler.BobGuess,
          myTurn: true,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [transition],
  );

  return {
    gameState: gs,
    setSecretWord,
    submitGuess,
  };
}
