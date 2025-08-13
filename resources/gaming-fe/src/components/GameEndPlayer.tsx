import React from "react";
import { useCallback, useState } from "react";
import { Box, Button, Typography, Paper } from "@mui/material";
import { popcount } from '../util';
import { card_color, CalpokerOutcome, PlayerSwappingCardLists } from '../types/ChiaGaming';
import PlayingCard from "./PlayingCard";

interface GameEndPlayerProps {
  iStarted: boolean;
  playerNumber: number;
  outcome: CalpokerOutcome;
  showSwapAnimation: boolean;
  swappingCards: PlayerSwappingCardLists;
  cardSelections: number;
}

const GameEndPlayer: React.FC<GameEndPlayerProps> = ({
    iStarted,
    playerNumber,
    outcome,
    showSwapAnimation,
    swappingCards,
    cardSelections,
}) => {
  const iAmAlice = playerNumber === 2;
  const playerHand: number[][] = iAmAlice ? outcome.alice_cards : outcome.bob_cards;
  const who = (iStarted !== iAmAlice) ? 'Your' : 'Opponent';
  const whoTitle = (iStarted !== iAmAlice) ? 'You' : 'Opponent';
  const cardColors = {
    'my-used': '#4d4',
    'my-final': '#bfb',
    'their-used': '#bbb',
    'their-final': '#fff'
  };
  const idWho = iStarted !== iAmAlice ? 'player' : 'ai';
  const emptySetSelection = useCallback(() => { }, []);

  const sectionStyle: React.CSSProperties = {
    width: '100%',
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '8px',
    borderRadius: '8px',
    maxWidth: '100%',
    margin: '0 auto',
  };

  const cardRowStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  };

  return (
    <div style={sectionStyle} data-area="player">
      <h3 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '4px', color: '#4b5563' }}>{who} Hand</h3>
      <div style={cardRowStyle}>
            {playerHand.map((card: number[], index) => {
            const isBeingSwapped = showSwapAnimation && swappingCards.player.some(c => c.originalIndex === index);
            return (
            <PlayingCard
                id={`${idWho}-${index}`}
                key={index}
                index={index}
                selected={!!(cardSelections & (1 << index))}
                cardValue={card}
                setSelection={emptySetSelection}
                isBeingSwapped={isBeingSwapped}
            />
            );
            })}
        </div>
    </div>
  );
};

export default GameEndPlayer;

