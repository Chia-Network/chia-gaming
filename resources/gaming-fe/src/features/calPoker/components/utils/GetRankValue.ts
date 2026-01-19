const getRankValue = (rank: any) => {
  const rankValues: Record<string, number> = {
    A: 14,
    K: 13,
    Q: 12,
    J: 11,
    T: 10,
  };
  return rankValues[rank] || parseInt(rank);
};

export default getRankValue;