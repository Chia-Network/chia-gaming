import { FormatHandProps } from "../../../types/californiaPoker";

const compareRanks = (rank1: FormatHandProps, rank2: FormatHandProps) => {
  if (rank1.score !== rank2.score) {
    return rank1.score - rank2.score;
  }

  for (
    let i = 0;
    i < Math.max(rank1.tiebreakers.length, rank2.tiebreakers.length);
    i++
  ) {
    const val1 = rank1.tiebreakers[i] || 0;
    const val2 = rank2.tiebreakers[i] || 0;
    if (val1 !== val2) return val1 - val2;
  }

  return 0;
};

export default compareRanks;