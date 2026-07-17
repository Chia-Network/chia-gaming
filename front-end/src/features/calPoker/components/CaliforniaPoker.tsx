import { useState, useEffect, useCallback, useRef } from 'react';
// Types
import {
  BestHandType,
  CaliforniapokerProps,
  CardValueSuit,
  MovingCardData,
} from '../../../types/californiaPoker';
// Constants
import {
  GAME_STATES,
  PRE_SWAP_REVEAL_DURATION,
  SWAP_ANIMATION_DURATION,
} from './constants/constants';

// Utils
import { formatHandDescription, makeDescription, formatCardsForLog, formatOrderedCardsForLog, orderUsedCardsForLog } from './utils';
import { HandDisplay, MovingCard } from './components';
import {
  cardIdToRankSuit,
  handValueToDescription,
} from '../../../types/ChiaGaming';
import { SuitName } from '../../../types/californiaPoker/CardValueSuit';
import {
  CalpokerDisplaySnapshotView,
  CalpokerOutcomeView,
} from '../../../types/californiaPoker/CaliforniapokerProps';
import GameBottomBar from './components/GameBottomBar';
import { calpokerSettlementVerb } from '../../../lib/settlement';


function translateTopline(topline: string | undefined): string | null {
  if (!topline) return null;
  const res = { win: 'player', lose: 'ai' }[topline];
  return res ? res : 'tie';
}

// Main Component
const CaliforniaPoker: React.FC<CaliforniapokerProps> = ({
  moveNumber,
  playerNumber,
  playerHand,
  opponentHand,
  cardSelections,
  setCardSelections,
  setHandOrder,
  handleMakeMove,
  outcome,
  myWinOutcome,
  onGameLog,
  onSnapshotChange,
  initialSnapshot,
  myName,
  opponentName,
  timeoutByUs,
  timeoutForfeited,
  settlementOutcome,
}) => {
  const settlementVerb = settlementOutcome
    ? calpokerSettlementVerb(settlementOutcome)
    : (timeoutForfeited ? 'forfeited' : 'timed out');
  const [gameState, setGameState] = useState(GAME_STATES.INITIAL);
  // const [playerCards, setPlayerHand] = useState<CardValueSuit[]>([]);
  const suitMap: Record<number, SuitName> = {
    0: 'Q',
    1: '♠',
    2: '♥',
    3: '♦',
    4: '♣',
  };

  const wrapperRef = useRef<HTMLDivElement>(null);
  const [playerCards, setPlayerCards] = useState<CardValueSuit[]>([]);
  const [opponentCards, setOpponentCards] = useState<CardValueSuit[]>([]);
  const [rememberedOutcome, setRememberedOutcome] = useState<
    CalpokerOutcomeView | undefined
  >(undefined);
  const rememberedCardsRef = useRef<CardValueSuit[][]>([[], []]);
  const [playerDisplayText, setPlayerDisplayText] = useState<string>('');
  const [opponentDisplayText, setOpponentDisplayText] = useState<string>('');

  const cvsFromCard = (cardId: string): CardValueSuit => {
    const { rank, suit } = cardIdToRankSuit(BigInt(cardId));
    return { rank, suit: suitMap[suit], cardId };
  };

  const cardsToBigints = (cardIds: string[]): bigint[] => cardIds.map((cardId) => BigInt(cardId));

  useEffect(() => {
    if (outcome) {
      setRememberedOutcome(outcome);
    }
    const inAnimation =
      gameState === GAME_STATES.AWAITING_SWAP ||
      gameState === GAME_STATES.REVEALING_SWAP ||
      gameState === GAME_STATES.SWAPPING ||
      gameState === GAME_STATES.FINAL;
    if (!inAnimation) {
      const mappedPlayer = playerHand.map(cvsFromCard);
      const mappedOpponent = opponentHand.map(cvsFromCard);
      setPlayerCards(mappedPlayer);
      setOpponentCards(mappedOpponent);
      if (mappedPlayer.length && mappedOpponent.length) {
        rememberedCardsRef.current = [mappedPlayer, mappedOpponent];
      }
    }
  }, [playerHand, opponentHand, outcome, gameState, initialSnapshot]);

  useEffect(() => {
    const haveOutcome = outcome ? outcome : rememberedOutcome;
    if (
      haveOutcome &&
      gameState === GAME_STATES.AWAITING_SWAP
    ) {
      swapCards(haveOutcome);
    }
  }, [outcome, gameState, moveNumber, rememberedOutcome]);

  // const [opponentCards, setAiHand] = useState<CardValueSuit[]>([]);
  const [winner, setWinner] = useState<string | null>(null);
  const [playerBestHand, setPlayerBestHand] = useState<
    BestHandType | undefined
  >();
  const [aiBestHand, setAiBestHand] = useState<BestHandType | undefined>();
  const [showSwapAnimation, setShowSwapAnimation] = useState(false);
  const [movingCards, setMovingCards] = useState<MovingCardData[]>([]);
  const [playerHaloCardIds, setPlayerHaloCardIds] = useState<string[]>([]);
  const [opponentHaloCardIds, setOpponentHaloCardIds] = useState<string[]>([]);
  const [playerSwapHiddenIds, setPlayerSwapHiddenIds] = useState<string[]>([]);
  const [opponentSwapHiddenIds, setOpponentSwapHiddenIds] = useState<string[]>([]);

  const dealCards = () => {
    setGameState(GAME_STATES.SELECTING);
    setCardSelections([]);
    setWinner(null);
    saveSnapshot(
      GAME_STATES.SELECTING, null, undefined, undefined, [], [], '', '',
    );
  };

  const toggleCardSelection = (cardId: string) => {
    if (gameState !== GAME_STATES.SELECTING) return;

    setCardSelections((prev: string[]) => {
      if (prev.includes(cardId)) {
        return prev.filter((id) => id !== cardId);
      }
      return [...prev, cardId];
    });
  };

  const handleReorder = useCallback((reordered: CardValueSuit[]) => {
    setPlayerCards(reordered);
    rememberedCardsRef.current = [reordered, rememberedCardsRef.current[1]];
    setHandOrder(reordered.map(c => c.cardId!));
    const snapshotPlayerHalos = gameState === GAME_STATES.SELECTING
      ? cardSelections
      : playerHaloCardIds;
    const snap: CalpokerDisplaySnapshotView = {
      gameState,
      winner,
      playerBestHandCardIds: playerBestHand?.cards.map(c => c.cardId!) ?? [],
      opponentBestHandCardIds: aiBestHand?.cards.map(c => c.cardId!) ?? [],
      playerHaloCardIds: snapshotPlayerHalos,
      opponentHaloCardIds: opponentHaloCardIds,
      playerDisplayText,
      opponentDisplayText,
    };
    onSnapshotChange(snap);
  }, [
    aiBestHand,
    cardSelections,
    gameState,
    onSnapshotChange,
    opponentDisplayText,
    opponentHaloCardIds,
    playerBestHand,
    playerDisplayText,
    playerHaloCardIds,
    setHandOrder,
    winner,
  ]);

  // Keyboard: 1-8 toggles the card at that position
  const playerCardsRef = useRef<CardValueSuit[]>(playerCards);
  playerCardsRef.current = playerCards;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (gameState !== GAME_STATES.SELECTING) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key >= '1' && e.key <= '8') {
        const index = parseInt(e.key) - 1;
        const cards = playerCardsRef.current;
        if (index < cards.length && cards[index].cardId !== undefined) {
          setCardSelections((prev: string[]) => {
            const cardId = cards[index].cardId!;
            if (prev.includes(cardId)) {
              return prev.filter((id) => id !== cardId);
            }
            return [...prev, cardId];
          });
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [gameState, setCardSelections]);

  const isDisabled =
    cardSelections.length !== 4;

  const playerHalos = gameState === GAME_STATES.SELECTING
    ? cardSelections
    : playerHaloCardIds;
  const opponentHalos = opponentHaloCardIds;

  const buttonText = cardSelections.length === 4
    ? 'Play Selected Cards'
    : `Select 4 cards (${cardSelections.length}/4)`;

  const opponentLabel = opponentName ?? 'Opponent';
  const myLabel = myName ?? 'You';
  const showFinalHeader = gameState === GAME_STATES.FINAL && !!winner && !showSwapAnimation;
  const opponentResultVerb = winner === 'tie' ? 'ties' : winner === 'ai' ? 'wins' : 'loses';
  const playerResultVerb = winner === 'tie' ? 'ties' : winner === 'player' ? 'wins' : 'loses';
  const resultLabel = (label: string, verb: 'wins' | 'loses' | 'ties') => {
    if (label === 'You') {
      return `You ${verb === 'wins' ? 'win' : verb === 'loses' ? 'lose' : 'tie'}`;
    }
    return `${label} ${verb}`;
  };
  const possessive = (label: string) => label === 'You' ? 'Your' : `${label}'s`;

  const doHandleMakeMove = () => {
    if (gameState === GAME_STATES.SELECTING && cardSelections.length > 0) {
      const halos = [...cardSelections];
      setPlayerHaloCardIds(halos);
      setGameState(GAME_STATES.AWAITING_SWAP);
      saveSnapshot(
        GAME_STATES.AWAITING_SWAP, null, undefined, undefined, halos, [], '', '',
      );
    }

    handleMakeMove();
  };

  //
  // playerSwapCardIds are the player cards given to the opponent.
  // aiSwapCardIds are the opponent cards given to the player.
  // playerCards and opponentCards are the local card data.
  //
  const calculateMovingCards = (
    playerSwapCardIds: string[],
    aiSwapCardIds: string[],
    playerCards: CardValueSuit[],
    opponentCards: CardValueSuit[],
  ): MovingCardData[] => {
    const movingCardData: MovingCardData[] = [];
    const usedPlayerCards = new Set<string>();
    const usedAiCards = new Set<string>();

    const wrapperRect = wrapperRef.current?.getBoundingClientRect();
    const offsetX = wrapperRect?.left ?? 0;
    const offsetY = wrapperRect?.top ?? 0;

    // Prefixes for DOM selectors (myPrefix = viewer's hand in DOM)
    const myPrefix = 'player';
    const oppPrefix = 'ai';

    const sortByDomX = (ids: string[], prefix: string) =>
      [...ids].sort((a, b) => {
        const elA = document.querySelector(`[data-card-id="${prefix}-${a}"]`);
        const elB = document.querySelector(`[data-card-id="${prefix}-${b}"]`);
        if (!elA || !elB) return 0;
        return elA.getBoundingClientRect().left - elB.getBoundingClientRect().left;
      });
    const sortedPlayerSwaps = sortByDomX(playerSwapCardIds, myPrefix);
    const sortedAiSwaps = sortByDomX(aiSwapCardIds, oppPrefix);

    // Player -> Opponent animations
    sortedPlayerSwaps.forEach((swapCardId, i) => {
      const aiCardId = sortedAiSwaps[i];
      if (aiCardId === undefined) {
        return;
      }
      usedPlayerCards.add(swapCardId);

      const mySource = document.querySelector(
        `[data-card-id="${myPrefix}-${swapCardId}"]`,
      );
      const oppTarget = document.querySelector(
        `[data-card-id="${oppPrefix}-${aiCardId}"]`,
      );

      if (mySource && oppTarget) {
        const myRect = (mySource as Element).getBoundingClientRect();
        const oppRect = (oppTarget as Element).getBoundingClientRect();

        const card = playerCards.find((c) => c.cardId === swapCardId);
        if (!card) {
          return;
        }
        movingCardData.push({
          id: `${myPrefix}-to-${oppPrefix}-${swapCardId}`,
          card,
          startX: myRect.left - offsetX,
          startY: myRect.top - offsetY,
          endX: oppRect.left - offsetX,
          endY: oppRect.top - offsetY,
          width: myRect.width,
          height: myRect.height,
          direction: 'playerToAi',
          zIndex: 0,
        });
      }
    });

    // Opponent -> Player animations
    sortedAiSwaps.forEach((swapCardId, i) => {
      const playerCardId = sortedPlayerSwaps[i];
      if (playerCardId === undefined) {
        return;
      }
      usedAiCards.add(swapCardId);

      const oppSource = document.querySelector(
        `[data-card-id="${oppPrefix}-${swapCardId}"]`,
      );
      const myTarget = document.querySelector(
        `[data-card-id="${myPrefix}-${playerCardId}"]`,
      );

      if (oppSource && myTarget) {
        const oppRect = (oppSource as Element).getBoundingClientRect();
        const myRect = (myTarget as Element).getBoundingClientRect();

        const card = opponentCards.find((c) => c.cardId === swapCardId);
        if (!card) {
          return;
        }
        movingCardData.push({
          id: `${oppPrefix}-to-${myPrefix}-${swapCardId}`,
          card,
          startX: oppRect.left - offsetX,
          startY: oppRect.top - offsetY,
          endX: myRect.left - offsetX,
          endY: myRect.top - offsetY,
          width: oppRect.width,
          height: oppRect.height,
          direction: 'aiToPlayer',
          zIndex: 0,
        });
      }
    });

    const selfCardAnimate = (
      myPrefix: string,
      usedCards: Set<string>,
      card: CardValueSuit,
      i: number,
    ) => {
      if (card.cardId === undefined) {
        return;
      }
      if (usedCards.has(card.cardId)) {
        return;
      }
      // source = dest
      const source = document.querySelector(
        `[data-card-id="${myPrefix}-${card.cardId}"]`,
      );
      if (source) {
        const myRect = (source as Element).getBoundingClientRect();
        movingCardData.push({
          id: `${myPrefix}-to-${myPrefix}-${card.cardId}`,
          card,
          startX: myRect.left - offsetX,
          startY: myRect.top - offsetY,
          endX: myRect.left - offsetX,
          endY: myRect.top - offsetY,
          width: myRect.width,
          height: myRect.height,
          direction: 'self',
          zIndex: 0,
        });
      }
    };

    playerCards.forEach((card, i) =>
      selfCardAnimate(myPrefix, usedPlayerCards, card, i),
    );
    opponentCards.forEach((card, i) =>
      selfCardAnimate(oppPrefix, usedAiCards, card, i),
    );

    // Assign z-indexes: player swap cards highest (rightmost first),
    // then opponent swap cards (rightmost first), then non-swapping cards lowest.
    const playerSwaps = movingCardData
      .filter(c => c.direction === 'playerToAi')
      .sort((a, b) => b.startX - a.startX);
    const aiSwaps = movingCardData
      .filter(c => c.direction === 'aiToPlayer')
      .sort((a, b) => b.startX - a.startX);
    let z = 100;
    for (const c of playerSwaps) { c.zIndex = z--; }
    for (const c of aiSwaps) { c.zIndex = z--; }
    for (const c of movingCardData) {
      if (c.direction === 'self') c.zIndex = 50;
    }

    return movingCardData;
  };

  const swapCards = (rememberedOutcome: CalpokerOutcomeView) => {
    const liveWinner = translateTopline(rememberedOutcome.my_win_outcome);
    setWinner(liveWinner);
    setGameState(GAME_STATES.REVEALING_SWAP);

    const playerOriginal = rememberedOutcome.my_cards;
    const opponentOriginal = rememberedOutcome.their_cards;
    const playerFinal = rememberedOutcome.my_final_hand;
    const opponentFinal = rememberedOutcome.their_final_hand;

    const playerFinalSet = new Set(playerFinal);
    const opponentFinalSet = new Set(opponentFinal);
    const playerDiscardIds = playerOriginal.filter(id => !playerFinalSet.has(id));
    const opponentDiscardIds = opponentOriginal.filter(id => !opponentFinalSet.has(id));

    const playerKeptIds = playerOriginal.filter(id => playerFinalSet.has(id));
    const opponentKeptIds = opponentOriginal.filter(id => opponentFinalSet.has(id));
    const resultWord = rememberedOutcome.my_win_outcome === 'win' ? 'Win'
                     : rememberedOutcome.my_win_outcome === 'lose' ? 'Lose' : 'Tie';
    const myOrdered = orderUsedCardsForLog(cardsToBigints(rememberedOutcome.my_used_cards), cardsToBigints(rememberedOutcome.my_hand_value)).map(String);
    const theirOrdered = orderUsedCardsForLog(cardsToBigints(rememberedOutcome.their_used_cards), cardsToBigints(rememberedOutcome.their_hand_value)).map(String);
    onGameLog([
      `${formatCardsForLog(cardsToBigints(playerKeptIds))} give ${formatCardsForLog(cardsToBigints(playerDiscardIds))}`,
      `${formatCardsForLog(cardsToBigints(opponentKeptIds))} give ${formatCardsForLog(cardsToBigints(opponentDiscardIds))}`,
      `${resultWord} ${formatOrderedCardsForLog(cardsToBigints(myOrdered))} vs ${formatOrderedCardsForLog(cardsToBigints(theirOrdered))}`,
    ]);

    setPlayerHaloCardIds(playerDiscardIds);
    setOpponentHaloCardIds(opponentDiscardIds);
    setPlayerSwapHiddenIds(playerDiscardIds);
    setOpponentSwapHiddenIds(opponentDiscardIds);

    const myUsedCards = rememberedOutcome.my_used_cards;
    const oppUsedCards = rememberedOutcome.their_used_cards;
    const myHandValue = rememberedOutcome.my_hand_value;
    const oppHandValue = rememberedOutcome.their_hand_value;

    const playerBestCards: CardValueSuit[] = myUsedCards.map(cvsFromCard);
    const opponentBestCards: CardValueSuit[] = oppUsedCards.map(cvsFromCard);
    const pBest: BestHandType = {
      cards: playerBestCards,
      rank: { name: '', score: 0, tiebreakers: [] },
    };
    const oBest: BestHandType = {
      cards: opponentBestCards,
      rank: { name: '', score: 0, tiebreakers: [] },
    };

    saveSnapshot(
      GAME_STATES.REVEALING_SWAP,
      liveWinner,
      undefined,
      undefined,
      playerDiscardIds,
      opponentDiscardIds,
      playerDisplayText,
      opponentDisplayText,
    );

    const playerSwapCardIds = playerDiscardIds;
    const aiSwapCardIds = opponentDiscardIds;

    setTimeout(() => {
      setGameState(GAME_STATES.SWAPPING);
      const remembered = rememberedCardsRef.current;
      const movingCardData = calculateMovingCards(
        playerSwapCardIds,
        aiSwapCardIds,
        remembered[0],
        remembered[1],
      );
      setMovingCards(movingCardData);
      setShowSwapAnimation(true);

      setTimeout(() => {
      const playerDiscardToIncoming = new Map<string, string>();
      for (let i = 0; i < playerSwapCardIds.length; i++) {
        playerDiscardToIncoming.set(playerSwapCardIds[i], aiSwapCardIds[i]);
      }
      const opponentDiscardToIncoming = new Map<string, string>();
      for (let i = 0; i < aiSwapCardIds.length; i++) {
        opponentDiscardToIncoming.set(aiSwapCardIds[i], playerSwapCardIds[i]);
      }

      const ref = rememberedCardsRef.current;
      const newPlayer = ref[0].map(c => {
        const incoming = playerDiscardToIncoming.get(c.cardId!);
        return incoming !== undefined ? cvsFromCard(incoming) : c;
      });
      const newOpponent = ref[1].map(c => {
        const incoming = opponentDiscardToIncoming.get(c.cardId!);
        return incoming !== undefined ? cvsFromCard(incoming) : c;
      });

      setPlayerCards(newPlayer);
      setOpponentCards(newOpponent);
      rememberedCardsRef.current = [newPlayer, newOpponent];
      setHandOrder(
        newPlayer.map(c => c.cardId!),
        newOpponent.map(c => c.cardId!),
      );

      setPlayerHaloCardIds(aiSwapCardIds);
      setOpponentHaloCardIds(playerSwapCardIds);
      setPlayerSwapHiddenIds([]);
      setOpponentSwapHiddenIds([]);
      setPlayerBestHand(pBest);
      setAiBestHand(oBest);

      setMovingCards([]);
      setShowSwapAnimation(false);
      setGameState(GAME_STATES.FINAL);
      const pText = makeDescription(handValueToDescription(cardsToBigints(myHandValue), cardsToBigints(myUsedCards)));
      const oText = makeDescription(handValueToDescription(cardsToBigints(oppHandValue), cardsToBigints(oppUsedCards)));
      setPlayerDisplayText(pText);
      setOpponentDisplayText(oText);
      saveSnapshot(
        GAME_STATES.FINAL, liveWinner, pBest, oBest, aiSwapCardIds, playerSwapCardIds, pText, oText,
      );
      }, SWAP_ANIMATION_DURATION);
    }, PRE_SWAP_REVEAL_DURATION);
  };

  const saveSnapshot = useCallback((
    gs: string,
    w: string | null,
    pBest: BestHandType | undefined,
    oBest: BestHandType | undefined,
    pHalo: string[],
    oHalo: string[],
    pText: string,
    oText: string,
  ) => {
    const snap: CalpokerDisplaySnapshotView = {
      gameState: gs,
      winner: w,
      playerBestHandCardIds: pBest?.cards.map(c => c.cardId!) ?? [],
      opponentBestHandCardIds: oBest?.cards.map(c => c.cardId!) ?? [],
      playerHaloCardIds: pHalo,
      opponentHaloCardIds: oHalo,
      playerDisplayText: pText,
      opponentDisplayText: oText,
    };
    onSnapshotChange(snap);
  }, [onSnapshotChange]);

  useEffect(() => {
    if (initialSnapshot) {
      const snap = initialSnapshot;
      const restoredGameState = moveNumber === '1' && !outcome
        ? GAME_STATES.SELECTING
        : snap.gameState;
      setGameState(restoredGameState);
      setWinner(snap.winner);
      setPlayerHaloCardIds(snap.playerHaloCardIds);
      setOpponentHaloCardIds(snap.opponentHaloCardIds);
      setPlayerDisplayText(snap.playerDisplayText);
      setOpponentDisplayText(snap.opponentDisplayText);
      if (snap.playerBestHandCardIds.length > 0) {
        setPlayerBestHand({
          cards: snap.playerBestHandCardIds.map(cvsFromCard),
          rank: { name: '', score: 0, tiebreakers: [] },
        });
      }
      if (snap.opponentBestHandCardIds.length > 0) {
        setAiBestHand({
          cards: snap.opponentBestHandCardIds.map(cvsFromCard),
          rank: { name: '', score: 0, tiebreakers: [] },
        });
      }
    } else {
      dealCards();
    }
  }, []);

  useEffect(() => {
    if (
      moveNumber === '0' &&
      !showSwapAnimation &&
      gameState !== GAME_STATES.AWAITING_SWAP &&
      gameState !== GAME_STATES.REVEALING_SWAP &&
      gameState !== GAME_STATES.SWAPPING &&
      gameState !== GAME_STATES.FINAL
    ) {
      setGameState(GAME_STATES.SELECTING);
      rememberedCardsRef.current = [[], []];
      setRememberedOutcome(undefined);
      setWinner(null);
      setMovingCards([]);
      setPlayerBestHand(undefined);
      setAiBestHand(undefined);
      setShowSwapAnimation(false);
      setPlayerDisplayText('');
      setOpponentDisplayText('');
      setPlayerHaloCardIds([]);
      setOpponentHaloCardIds([]);
      setPlayerSwapHiddenIds([]);
      setOpponentSwapHiddenIds([]);
    }
  }, [moveNumber, showSwapAnimation, gameState]);
  return (
    <div ref={wrapperRef} className='relative flex flex-col w-full text-canvas-text'>
      <div className='flex flex-col gap-2'>
        {/* Hands region */}
        <div className='flex flex-col gap-2'>
          <div className='flex flex-col py-0 w-full rounded-md'>
            <div className='w-full h-8 flex items-center justify-center text-base font-semibold text-canvas-text'>
              <span className='truncate max-w-full'>
                {showFinalHeader && opponentDisplayText
                  ? `${resultLabel(opponentLabel, opponentResultVerb)} (${opponentDisplayText})`
                  : timeoutByUs === true
                    ? resultLabel(opponentLabel, 'wins')
                    : timeoutByUs === false
                      ? `${opponentLabel} ${settlementVerb}`
                      : `${possessive(opponentLabel)} Hand`}
              </span>
            </div>
            <div className='flex items-center justify-center p-2'>
              <HandDisplay
                title=''
                cards={
                  opponentCards.length ? opponentCards : rememberedCardsRef.current[1]
                }
                playerNumber={playerNumber == 1 ? 2 : 1}
                area='ai'
                winner={winner}
                winnerType='ai'
                bestHand={aiBestHand}
                showSwapAnimation={showSwapAnimation}
                gameState={gameState}
                haloCardIds={opponentHalos}
                swapHiddenCardIds={opponentSwapHiddenIds}
                formatHandDescription={formatHandDescription}
                selectedCards={[]}
                timeoutBadge={timeoutByUs === true ? 'winner' : timeoutByUs === false ? (timeoutForfeited ? 'forfeit' : 'timeout') : null}
              />
            </div>
          </div>

          <div className='flex flex-col py-0 w-full rounded-md'>
            <div className='w-full h-8 flex items-center justify-center text-base font-semibold text-canvas-text'>
              <span className='truncate max-w-full'>
                {showFinalHeader && playerDisplayText
                  ? `${resultLabel(myLabel, playerResultVerb)} (${playerDisplayText})`
                  : timeoutByUs === true
                    ? `${myLabel} ${settlementVerb}`
                    : timeoutByUs === false
                      ? resultLabel(myLabel, 'wins')
                      : `${possessive(myLabel)} Hand`}
              </span>
            </div>
            <div className='flex items-center justify-center p-2'>
              <HandDisplay
                title=''
                cards={
                  playerCards.length ? playerCards : rememberedCardsRef.current[0]
                }
                playerNumber={playerNumber}
                area='player'
                winner={winner}
                winnerType='player'
                bestHand={playerBestHand}
                onCardClick={toggleCardSelection}
                selectedCards={cardSelections}
                showSwapAnimation={showSwapAnimation}
                gameState={gameState}
                haloCardIds={playerHalos}
                swapHiddenCardIds={playerSwapHiddenIds}
                onReorder={gameState === GAME_STATES.SELECTING ? handleReorder : undefined}
                formatHandDescription={formatHandDescription}
                timeoutBadge={timeoutByUs === true ? (timeoutForfeited ? 'forfeit' : 'timeout') : timeoutByUs === false ? 'winner' : null}
              />
            </div>
          </div>
        </div>

        {/* Action bar — only during active gameplay */}
        {(gameState === GAME_STATES.SELECTING || gameState === GAME_STATES.AWAITING_SWAP) && !outcome && (
          <div className='flex-shrink-0 w-full h-12 relative flex items-center justify-center'>
            {gameState === GAME_STATES.SELECTING && moveNumber === '1' && (
              <GameBottomBar
                buttonText={buttonText}
                isDisabled={isDisabled}
                doHandleMakeMove={doHandleMakeMove}
              />
            )}
            {gameState === GAME_STATES.AWAITING_SWAP && timeoutByUs == null && (
              <div className='rounded-md bg-canvas-bg px-4 py-2 text-sm font-medium text-canvas-text shadow-md'>
                Waiting for opponent
              </div>
            )}
          </div>
        )}
      </div>

      {/* Animations */}
      {movingCards.map((cardData) => (
        <MovingCard
          key={cardData.id}
          cardData={cardData}
          showAnimation={showSwapAnimation}
        />
      ))}
    </div>
  );
};

export default CaliforniaPoker;