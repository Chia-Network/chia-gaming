import { CardValueSuit } from "./CardValueSuit";
import { FormatHandProps } from "./FormatHandProps";

interface BestHandType {
  cards: CardValueSuit[];
  rank: FormatHandProps;
}
export type { BestHandType };