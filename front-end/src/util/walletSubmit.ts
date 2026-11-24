/** Heights only advance, so short of a reorg these exact bytes can never be accepted. */
export function isPastDeadlineRejection(detail: string): boolean {
  return /\bASSERT_BEFORE_HEIGHT_(?:RELATIVE|ABSOLUTE)_FAILED\b/.test(detail);
}

export function isExactDuplicateTransaction(detail: string): boolean {
  return (
    /\bALREADY_INCLUDING_TRANSACTION\b/i.test(detail) ||
    /\bduplicate transaction\b/i.test(detail) ||
    /\btransaction (?:is |was |has been )?already (?:included|in (?:the )?mempool)\b/i.test(detail)
  );
}

export function rateLimitedSubmissionDelayMs(detail: string): number | null {
  const match = /\bRate limit exceeded, please try again in ([1-9][0-9]*) seconds?\b/i.exec(detail);
  return match ? Number(match[1]) * 1_000 : null;
}
