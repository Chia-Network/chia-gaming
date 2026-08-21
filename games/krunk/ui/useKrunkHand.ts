import { useEffect, useCallback, useRef } from 'react';
import { Program } from 'clvm-lib';
import {
  DEFAULT_CURRENCY_LABELS,
  gameHandState,
  requireLiveGameHandSource,
  type CurrencyLabels,
  type GameHandSource,
  type GameTerminalModel,
} from '../../host';
import { krunkSettlementStatus } from './settlement';
import { krunkOutcomeFromPlay } from './handProposal';
import {
  krunkGameStateFromPersisted,
  KrunkHandler,
  type KrunkGameState,
  type KrunkGuess,
  type KrunkRole,
} from './serialize';

type LocalGameCommand =
  | { type: 'make-move'; readable: Program | null }
  | { type: 'accept-settlement' }
  | { type: 'cheat'; moverShare: bigint };

export { KrunkHandler };
export { applyKrunkMoveRejected } from './serialize';
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
    if (
      terminal.outcome === 'opponent_timed_out' ||
      terminal.outcome === 'timed_out_waiting_for_our_move'
    ) {
      const weTimedOut = terminal.outcome === 'timed_out_waiting_for_our_move';
      const guesserLabel = state.role === 'bob' ? 'You' : opponentLabel;
      const guesserTimedOut = state.role === 'bob' ? weTimedOut : !weTimedOut;
      if (!guesserTimedOut && gameAmount === null) {
        throw new Error('Krunk timeout winner is missing the game amount');
      }
      return {
        text: `${guesserLabel} got ${
          guesserTimedOut ? 'nothing' : krunkAmountLabel(gameAmount!)
        } due to timeout.`,
        kind: 'info',
      };
    }
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

function krunkAmountLabel(
  amount: string,
  labels: CurrencyLabels = DEFAULT_CURRENCY_LABELS,
): string {
  const mojos = BigInt(amount);
  if (mojos < 1_000_000n) return `${mojos} ${labels.mojo}`;
  const TRILLION = 1_000_000_000_000n;
  const whole = mojos / TRILLION;
  const frac = mojos % TRILLION;
  if (frac === 0n) return `${whole} ${labels.chia}`;
  const fracStr = frac.toString().padStart(12, '0').replace(/0+$/, '');
  return `${whole}.${fracStr} ${labels.chia}`;
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
  handSource: GameHandSource,
  gameId: string,
  iStarted: boolean,
  active = true,
): UseKrunkHandResult {
  const interactive = handSource.interactionMode === 'live' && active;
  // Channel-level convention: iStarted=true → I'm second mover in
  // every game. Krunk's first mover is alice (the committer), so the
  // channel initiator plays bob and the receiver plays alice.
  const role: KrunkRole = iStarted ? 'bob' : 'alice';
  const gameState = krunkGameStateFromPersisted(gameHandState(handSource), gameId, role);

  const gameStateRef = useRef(gameState);
  const handSourceRef = useRef(handSource);
  const gameIdRef = useRef(gameId);
  const activeRef = useRef(interactive);

  gameStateRef.current = gameState;
  handSourceRef.current = handSource;
  gameIdRef.current = gameId;
  activeRef.current = interactive;

  const commitLocalAction = useCallback((next: KrunkGameState, command: LocalGameCommand): void => {
    const gameId = gameIdRef.current;
    requireLiveGameHandSource(handSourceRef.current).dispatch(
      command.type === 'make-move'
        ? { type: 'make-move', gameId, readable: command.readable, state: next }
        : command.type === 'accept-settlement'
          ? { type: 'accept-settlement', gameId, state: next }
          : { type: 'cheat', gameId, moverShare: command.moverShare, state: next },
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
    const gid = gameIdRef.current;
    if (!activeRef.current || !gid) return;
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
      const gid = gameIdRef.current;
      const cur = gameStateRef.current;
      if (!gid) return;
      if (cur.role !== 'alice' || cur.handler !== KrunkHandler.WaitingCommit) return;
      const normalised = word.trim().toUpperCase();
      if (!/^[A-Z]{5}$/.test(normalised)) {
        console.warn('[krunk] secret word must be 5 letters');
        return;
      }
      requireLiveGameHandSource(handSourceRef.current);
      const next = {
        ...cur,
        secretWord: normalised,
        handler: KrunkHandler.AliceWaiting,
        myTurn: false,
        error: null,
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
      const gid = gameIdRef.current;
      const cur = gameStateRef.current;
      if (!gid) return;
      if (cur.role !== 'bob' || cur.handler !== KrunkHandler.BobGuess) return;
      const normalised = word.trim().toUpperCase();
      if (!/^[A-Z]{5}$/.test(normalised)) {
        console.warn('[krunk] guess must be 5 letters');
        return;
      }
      requireLiveGameHandSource(handSourceRef.current);
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
        error: null,
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
