import { useEffect, useRef, useState } from 'react';
import type { GameMountView } from '../../host';
import type { KrunkHand } from './serialize';

const WORD_LEN = 5;
const MAX_GUESSES = 5;
/** The hub allows 1000 frames per 10 seconds on a connection; this sends at most 100. */
const SEND_INTERVAL_MS = 100;

/** Guess letters that have not been played yet, starting at board row `row`. */
export interface KrunkLiveDraft {
  row: number;
  letters: string;
}

export function encodeKrunkLiveDraft({ row, letters }: KrunkLiveDraft): Uint8Array {
  return new TextEncoder().encode(`${row}:${letters}`);
}

/** Untrusted peer bytes; anything malformed is ignored. */
export function decodeKrunkLiveDraft(body: Uint8Array): KrunkLiveDraft | null {
  const match = /^([0-5]):([A-Z]{0,25})$/.exec(new TextDecoder().decode(body));
  if (!match) return null;
  const draft = { row: Number(match[1]), letters: match[2] };
  return draft.row * WORD_LEN + draft.letters.length <= MAX_GUESSES * WORD_LEN ? draft : null;
}

/**
 * Letters to show in each row from `playedRows` on. Moves and drafts arrive
 * separately, so rows that have since been played are skipped, and a draft
 * ahead of the board waits for its move.
 */
export function krunkLiveRows(draft: KrunkLiveDraft | null, playedRows: number): string[] {
  if (!draft || draft.row > playedRows) return [];
  const letters = draft.letters.slice((playedRows - draft.row) * WORD_LEN);
  return letters.match(/.{1,5}/g) ?? [];
}

/**
 * Share this player's unplayed guess letters and return the opponent's. Only
 * guesses may be passed here: the opponent already knows the word they are for.
 * The secret word draft must never be shared.
 */
export function useKrunkLiveDraft(
  view: GameMountView<KrunkHand>,
  mine: KrunkLiveDraft,
): KrunkLiveDraft | null {
  const port = view.frozen ? null : view.port;
  const [theirs, setTheirs] = useState<KrunkLiveDraft | null>(null);
  const lastSent = useRef<{ text: string; at: number }>({ text: '0:', at: 0 });

  useEffect(() => {
    if (!port?.onEphemeral) return;
    const unsubscribe = port.onEphemeral((body) => {
      const draft = decodeKrunkLiveDraft(body);
      if (draft) setTheirs(draft);
    });
    return () => {
      unsubscribe();
      setTheirs(null);
    };
  }, [port]);

  const { row, letters } = mine;
  useEffect(() => {
    if (!port?.sendEphemeral) return;
    const text = `${row}:${letters}`;
    if (text === lastSent.current.text) return;
    const send = () => {
      lastSent.current = { text, at: Date.now() };
      port.sendEphemeral!(encodeKrunkLiveDraft({ row, letters }));
    };
    const wait = lastSent.current.at + SEND_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      send();
      return;
    }
    const timer = setTimeout(send, wait);
    return () => clearTimeout(timer);
  }, [port, row, letters]);

  return theirs;
}
