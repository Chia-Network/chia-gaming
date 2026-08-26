import { useEffect, useCallback, useRef } from 'react';
import { Program } from 'clvm-lib';
import { requireLiveGameMount, type GameMountView } from '../../host';
import { krunkSettlementStatus } from './settlement';
import { krunkOutcomeFromPlay } from './handProposal';
import {
  krunkGameStateFromHand,
  KrunkHandler,
  type KrunkHand,
  type KrunkGameState,
  type KrunkGuess,
  type KrunkRole,
} from './serialize';

type LocalGameCommand =
  | { type: 'make-move'; readable: Program | null }
  | { type: 'accept-settlement' };

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

export interface KrunkBoardNotice {
  text: string;
  kind: 'error' | 'win' | 'info';
}

function krunkTerminalNotice(
  state: KrunkGameState,
  opponentLabel: string,
  perPlayerStake: bigint,
): KrunkBoardNotice | null {
  if (state.handler !== KrunkHandler.Terminal) return null;
  if (state.settlementOutcome != null) {
    if (
      state.settlementOutcome === 'opponent_timed_out' ||
      state.settlementOutcome === 'timed_out_waiting_for_our_move'
    ) {
      const weTimedOut = state.settlementOutcome === 'timed_out_waiting_for_our_move';
      const guesserLabel = state.role === 'bob' ? 'You' : opponentLabel;
      const guesserTimedOut = state.role === 'bob' ? weTimedOut : !weTimedOut;
      return {
        text: `${guesserLabel} got ${
          guesserTimedOut ? 'nothing' : krunkAmountLabel(perPlayerStake.toString())
        } due to timeout.`,
        kind: 'info',
      };
    }
    const clean =
      state.settlementOutcome === 'accept_settlement' ||
      state.settlementOutcome === 'we_accepted' ||
      state.settlementOutcome === 'settled_cleanly';
    if (!clean) {
      return { text: krunkSettlementStatus(state.settlementOutcome, opponentLabel), kind: 'info' };
    }
    const outcome = state.outcome ?? krunkOutcomeFromPlay(state);
    const winnerAmount =
      state.moverShare === null ? perPlayerStake : BigInt(state.moverShare);
    if (outcome === 'win') {
      if (state.role === 'alice') {
        return { text: `${opponentLabel} didn't win anything.`, kind: 'info' };
      }
      return {
        text: krunkWinMessage(winnerAmount.toString()),
        kind: 'win',
      };
    }
    if (outcome === 'lose') {
      if (state.role === 'bob') {
        return { text: "You didn't win anything.", kind: 'info' };
      }
      return {
        text:
          krunkWinnerMessage(opponentLabel, winnerAmount.toString()),
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
  perPlayerStake: bigint,
): string | null {
  return krunkTerminalNotice(state, opponentLabel, perPlayerStake)?.text ?? null;
}

export function krunkBoardNotice(
  state: KrunkGameState,
  opponentLabel: string,
  perPlayerStake: bigint,
): KrunkBoardNotice | null {
  return krunkTerminalNotice(state, opponentLabel, perPlayerStake);
}

/** Win banner copy: mojo below 1e6, chia at/above (same crossover as formatAmount). */
export function krunkWinMessage(moverShare: string): string {
  return krunkWinnerMessage('You', moverShare);
}

function krunkAmountLabel(amount: string): string {
  const mojos = BigInt(amount);
  if (mojos < 1_000_000n) return `${mojos} mojo`;
  const TRILLION = 1_000_000_000_000n;
  const whole = mojos / TRILLION;
  const frac = mojos % TRILLION;
  if (frac === 0n) return `${whole} chia`;
  const fracStr = frac.toString().padStart(12, '0').replace(/0+$/, '');
  return `${whole}.${fracStr} chia`;
}

export function krunkWinnerMessage(winner: string, amount: string): string {
  return `${winner} won ${krunkAmountLabel(amount)}!`;
}

const MAX_GUESSES = 5;

function wordToProgram(word: string): Program {
  // Krunk handlers receive `local_move` as a single CLVM atom: the
  // word bytes. Program.fromBytes wraps a buffer as a single atom.
  return Program.fromBytes(new TextEncoder().encode(word.toUpperCase()));
}

function finishedKrunkState(
  current: KrunkGameState,
  revealedWord: string | null,
  lastClue: KrunkGuess['clue'] | null,
  moverShare: string | null = null,
): KrunkGameState {
  const correct = (clue: KrunkGuess['clue']) => clue.every((value) => value === 2n);
  const bobGuessedCorrectly =
    current.guesses.some((guess) => correct(guess.clue)) ||
    (lastClue !== null && correct(lastClue));
  const aliceWon = !bobGuessedCorrectly;
  return {
    ...current,
    handler: KrunkHandler.Terminal,
    myTurn: false,
    revealedWord,
    moverShare,
    outcome:
      (current.role === 'alice' && aliceWon) || (current.role === 'bob' && !aliceWon)
        ? 'win'
        : 'lose',
  };
}

export function useKrunkHand(
  view: GameMountView<KrunkHand>,
  memberIndex: number,
): UseKrunkHandResult {
  const handState = view.hand.getState();
  const gameState = krunkGameStateFromHand(handState, memberIndex);
  const interactive = !view.frozen && gameState.handler !== KrunkHandler.Terminal;

  const gameStateRef = useRef(gameState);
  const viewRef = useRef(view);
  const memberIndexRef = useRef(memberIndex);
  const activeRef = useRef(interactive);

  gameStateRef.current = gameState;
  viewRef.current = view;
  memberIndexRef.current = memberIndex;
  activeRef.current = interactive;

  const commitLocalAction = useCallback((next: KrunkGameState, command: LocalGameCommand): void => {
    const memberIndex = memberIndexRef.current;
    const live = requireLiveGameMount(viewRef.current);
    live.hand.updateGame(memberIndex, () => next);
    live.port.dispatch(
      command.type === 'make-move'
        ? { type: 'make-move', memberIndex, readable: command.readable }
        : { type: 'accept-settlement', memberIndex },
    );
  }, []);

  // ── Auto-play ──
  // Alice's `krunk_alice_handler_clue` decides internally whether to
  // send a clue or the final reveal. The user has nothing to choose;
  // we just feed it nil.
  useEffect(() => {
    if (!interactive) return;
    if (
      !activeRef.current ||
      gameState.role !== 'alice' ||
      gameState.handler !== KrunkHandler.AliceClue ||
      !gameState.myTurn
    )
      return;
    if (!requireLiveGameMount(viewRef.current).port.isChannelReady()) return;
    if (!activeRef.current) return;
    const latest = gameState.guesses[gameState.guesses.length - 1];
    const isReveal =
      !!latest && (latest.clue.every((v) => v === 2n) || gameState.guesses.length >= MAX_GUESSES);
    const next = isReveal
      ? finishedKrunkState(gameState, gameState.secretWord, latest.clue)
      : { ...gameState, handler: KrunkHandler.AliceWaiting, myTurn: false };
    commitLocalAction(next, { type: 'make-move', readable: null });
  }, [gameState, interactive, commitLocalAction]);

  const setSecretWord = useCallback(
    (word: string) => {
      if (!activeRef.current) return;
      const cur = gameStateRef.current;
      if (cur.role !== 'alice' || cur.handler !== KrunkHandler.WaitingCommit) return;
      const normalised = word.trim().toUpperCase();
      if (!/^[A-Z]{5}$/.test(normalised)) {
        console.warn('[krunk] secret word must be 5 letters');
        return;
      }
      requireLiveGameMount(viewRef.current);
      const next = {
        ...cur,
        secretWord: normalised,
        handler: KrunkHandler.AliceWaiting,
        myTurn: false,
      } satisfies KrunkGameState;
      commitLocalAction(next, {
        type: 'make-move',
        readable: wordToProgram(normalised),
      });
    },
    [commitLocalAction],
  );

  const submitGuess = useCallback(
    (word: string) => {
      if (!activeRef.current) return;
      const cur = gameStateRef.current;
      if (cur.role !== 'bob' || cur.handler !== KrunkHandler.BobGuess) return;
      const normalised = word.trim().toUpperCase();
      if (!/^[A-Z]{5}$/.test(normalised)) {
        console.warn('[krunk] guess must be 5 letters');
        return;
      }
      requireLiveGameMount(viewRef.current);
      const next = {
        ...cur,
        guesses: [
          ...cur.guesses,
          // Use -1 as a "pending" sentinel; replaced when alice's
          // clue readable arrives.
          { word: normalised, clue: PENDING_CLUE },
        ],
        handler: KrunkHandler.BobWaiting,
        myTurn: false,
      } satisfies KrunkGameState;
      commitLocalAction(next, {
        type: 'make-move',
        readable: wordToProgram(normalised),
      });
    },
    [commitLocalAction],
  );

  return {
    gameState,
    setSecretWord,
    submitGuess,
  };
}
