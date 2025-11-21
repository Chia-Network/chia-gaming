function getCombinations<T>(cards: T[], size: number = 5): T[][] {
  const combinations: T[][] = [];

  // Use the same nested loop approach as the original to ensure no bias
  if (size === 5) {
    for (let i = 0; i < cards.length - 4; i++) {
      for (let j = i + 1; j < cards.length - 3; j++) {
        for (let k = j + 1; k < cards.length - 2; k++) {
          for (let l = k + 1; l < cards.length - 1; l++) {
            for (let m = l + 1; m < cards.length; m++) {
              combinations.push([
                cards[i],
                cards[j],
                cards[k],
                cards[l],
                cards[m],
              ]);
            }
          }
        }
      }
    }
  }

  return combinations;
}
export default getCombinations;