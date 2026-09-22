export function isExactDuplicateTransaction(detail: string): boolean {
  return (
    /\bALREADY_INCLUDING_TRANSACTION\b/i.test(detail) ||
    /\bduplicate transaction\b/i.test(detail) ||
    /\btransaction (?:is |was |has been )?already (?:included|in (?:the )?mempool)\b/i.test(detail)
  );
}
