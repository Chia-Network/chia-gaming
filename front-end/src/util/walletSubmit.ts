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
