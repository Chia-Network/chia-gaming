import { FormatHandProps } from "../../../types/californiaPoker";

function valueToDisplayName(value: number): string {
  const displayNames: Record<number, string> = {
    14: 'Ace',
    13: 'King',
    12: 'Queen',
    11: 'Jack',
    10: 'Ten',
  };
  return displayNames[value] || value.toString();
}

const formatHandDescription = (rank: FormatHandProps) => {
  const { score, name, tiebreakers } = rank;

  const formatters: Record<number, () => string> = {
    8: () => `${name} - ${valueToDisplayName(tiebreakers[0])} high`,
    7: () =>
      `${name} - ${valueToDisplayName(tiebreakers[0])}s with ${valueToDisplayName(tiebreakers[1])} kicker`,
    6: () =>
      `${name} - ${valueToDisplayName(tiebreakers[0])}s full of ${valueToDisplayName(tiebreakers[1])}s`,
    5: () =>
      `${name} - ${valueToDisplayName(tiebreakers[0])} high with ${tiebreakers.slice(1).map(valueToDisplayName).join(', ')} kickers`,
    4: () => `${name} - ${valueToDisplayName(tiebreakers[0])} high`,
    3: () =>
      `${name} - ${valueToDisplayName(tiebreakers[0])}s with ${tiebreakers.slice(1).map(valueToDisplayName).join(', ')} kickers`,
    2: () =>
      `${name} - ${valueToDisplayName(tiebreakers[0])}s and ${valueToDisplayName(tiebreakers[1])}s with ${valueToDisplayName(tiebreakers[2])} kicker`,
    1: () =>
      `${name} - ${valueToDisplayName(tiebreakers[0])}s with ${tiebreakers.slice(1).map(valueToDisplayName).join(', ')} kickers`,
    0: () =>
      `${name} - ${valueToDisplayName(tiebreakers[0])} high with ${tiebreakers.slice(1).map(valueToDisplayName).join(', ')} kickers`,
  };

  return formatters[score]();
};

export default formatHandDescription