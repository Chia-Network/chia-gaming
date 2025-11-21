const evaluateStraightPotential = (values: number[]) => {
  const uniqueValues = [...new Set(values)].sort((a, b) => b - a);

  let maxConsecutive = 1;
  let currentConsecutive = 1;

  for (let i = 1; i < uniqueValues.length; i++) {
    if (uniqueValues[i - 1] - uniqueValues[i] === 1) {
      currentConsecutive++;
      maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
    } else {
      currentConsecutive = 1;
    }
  }

  // Check for wheel potential (A-2-3-4 or A-2-3-5 or A-2-4-5 or A-3-4-5 or 2-3-4-5)
  const hasAce = uniqueValues.includes(14);
  const hasTwo = uniqueValues.includes(2);
  const hasThree = uniqueValues.includes(3);
  const hasFour = uniqueValues.includes(4);
  const hasFive = uniqueValues.includes(5);

  let wheelPotential = 0;
  if (hasAce && hasTwo && hasThree && hasFour && hasFive) {
    wheelPotential = 4; // Complete wheel
  } else if (
    hasAce &&
    [hasTwo, hasThree, hasFour, hasFive].filter(Boolean).length >= 3
  ) {
    wheelPotential = 3; // 4 cards to wheel
  } else if (
    hasAce &&
    [hasTwo, hasThree, hasFour, hasFive].filter(Boolean).length === 2
  ) {
    wheelPotential = 2; // 3 cards to wheel
  }

  maxConsecutive = Math.max(maxConsecutive, wheelPotential);

  return maxConsecutive === 4
    ? 300
    : maxConsecutive === 3
      ? 100
      : maxConsecutive === 2
        ? 30
        : 0;
};

export default evaluateStraightPotential;