const getSwapCombinations = (handSize = 8) => {
  const combinations: Array<any> = [];

  for (let i = 0; i < handSize - 3; i++) {
    for (let j = i + 1; j < handSize - 2; j++) {
      for (let k = j + 1; k < handSize - 1; k++) {
        for (let l = k + 1; l < handSize; l++) {
          combinations.push([i, j, k, l]);
        }
      }
    }
  }

  return combinations;
};
export default getSwapCombinations;