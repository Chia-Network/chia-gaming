function calculateBalancedRows(
  totalCards: number,
  containerWidth: number,
  cardWidth: number = 64,
  gap: number = 8,
): number[] {
  const cardsPerRow = Math.floor((containerWidth + gap) / (cardWidth + gap));

  if (cardsPerRow >= totalCards) {
    return [totalCards]; // All cards fit in one row
  }

  const rows = Math.ceil(totalCards / cardsPerRow);
  const balancedRows: Array<any> = [];

  // Distribute cards as evenly as possible
  const baseCardsPerRow = Math.floor(totalCards / rows);
  const remainder = totalCards % rows;

  for (let i = 0; i < rows; i++) {
    const cardsInThisRow = baseCardsPerRow + (i < remainder ? 1 : 0);
    balancedRows.push(cardsInThisRow);
  }

  return balancedRows;
}
export default calculateBalancedRows;