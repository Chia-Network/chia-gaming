import { CardValueSuit, MovingCardData } from "@/src/types/californiaPoker";

const calculateMovingCards = (
    playerSwapIndices: number[],
    aiSwapIndices: number[],
    playerNumber: number,
    playerCards: CardValueSuit[],
    opponentCards: CardValueSuit[],
): MovingCardData[] => {
    const movingCardData: MovingCardData[] = [];
    const isPlayerAlice = playerNumber === 1;

    // Prefixes for DOM selectors (myPrefix = viewer's hand in DOM)
    const myPrefix = isPlayerAlice ? 'player' : 'ai';
    const oppPrefix = isPlayerAlice ? 'ai' : 'player';

    // If one side swapped more cards, handle each side independently
    // Player -> Opponent animations
    playerSwapIndices.forEach((swapIndex, i) => {
        // Choose a target ai index — prefer aligned index if exists, otherwise reuse swapIndex
        const aiIndex = aiSwapIndices[i] ?? swapIndex;

        const mySource = document.querySelector(
            `[data-card-id="${myPrefix}-${swapIndex}"]`,
        );
        const oppTarget = document.querySelector(
            `[data-card-id="${oppPrefix}-${aiIndex}"]`,
        );

        if (mySource && oppTarget) {
            const myRect = (mySource as Element).getBoundingClientRect();
            const oppRect = (oppTarget as Element).getBoundingClientRect();

            movingCardData.push({
                id: `${myPrefix}-to-${oppPrefix}-${swapIndex}`,
                card: playerCards[swapIndex],
                startX: myRect.left,
                startY: myRect.top,
                endX: oppRect.left,
                endY: oppRect.top,
                width: myRect.width,
                height: myRect.height,
                direction: isPlayerAlice ? 'playerToAi' : 'aiToPlayer',
            });
        }
    });

    // Opponent -> Player animations
    aiSwapIndices.forEach((swapIndex, i) => {
        const playerIndex = playerSwapIndices[i] ?? swapIndex;

        const oppSource = document.querySelector(
            `[data-card-id="${oppPrefix}-${swapIndex}"]`,
        );
        const myTarget = document.querySelector(
            `[data-card-id="${myPrefix}-${playerIndex}"]`,
        );

        if (oppSource && myTarget) {
            const oppRect = (oppSource as Element).getBoundingClientRect();
            const myRect = (myTarget as Element).getBoundingClientRect();

            movingCardData.push({
                id: `${oppPrefix}-to-${myPrefix}-${swapIndex}`,
                card: opponentCards[swapIndex],
                startX: oppRect.left,
                startY: oppRect.top,
                endX: myRect.left,
                endY: myRect.top,
                width: oppRect.width,
                height: oppRect.height,
                direction: isPlayerAlice ? 'aiToPlayer' : 'playerToAi',
            });
        }
    });

    return movingCardData;
};
export default calculateMovingCards;