import { OutcomeHandType } from "@/src/types/ChiaGaming";
import { RANK_SYMBOLS } from "../constants/constants";


const getRankSymbol = (n: number) => RANK_SYMBOLS[n] ?? n.toString();

export const makeDescription = (desc: OutcomeHandType) => {
    const mappedValues = desc.values.map((v: number) => getRankSymbol(v));
    if (desc.rank) {
        return `${desc.name} ${mappedValues.join(', ')}`;
    }
    return `${desc.name} ${mappedValues[0]}`;
};