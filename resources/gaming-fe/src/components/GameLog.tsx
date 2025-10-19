import React, { useState, useCallback } from 'react';
import { Box, Typography, Paper } from '@mui/material';
import {
  OutcomeLogLine,
  OutcomeHandType,
  suitNames,
} from '../types/ChiaGaming';

interface GameLogProps {
  log: OutcomeLogLine[];
}

const GameLog: React.FC<GameLogProps> = ({ log }) => {
  const [logOpen, setLogOpen] = useState(false);

  const makeDescription = (desc: OutcomeHandType) => {
    if (desc.rank) {
      return `${desc.name} ${desc.values.toString()}`;
    }

    return `${desc.name} ${suitNames[desc.values[0]]}`;
  };

  const onClickHandler = useCallback(() => {
    setLogOpen(!logOpen);
  }, [logOpen]);

  const cardDisplay = (c: number[], index: number, idPrefix: string, selected: boolean) => {
    const suitName = suitNames[c[1]];
    const isRedSuit = suitName === '♥' || suitName === '♦';
    const suitColor = isRedSuit ? 'red' : 'black';
    return (
      <Paper
      id={`${idPrefix}-${index}`}
        elevation={1}
        style={{ color: suitColor, padding: '0.25em', marginLeft: '0.25em', background: (selected ? '#ddd' : 'white') }}
      >
        {c[0]}
        {suitName}
      </Paper>
    )
  };

  const playerDisplay = (me: boolean, desc: OutcomeHandType, hand: number[][]) => {
    const cards = hand.map((c,i) => cardDisplay(c, i, `outcome-${me ? "me" : "opponent"}`, false));
    return (
      <Typography
        style={{ display: 'flex', flexDirection: 'row', padding: '0.25em' }}
      >
        {makeDescription(desc)}
        <div
          style={{ display: 'flex', flexDirection: 'row', marginLeft: '0.5em' }}
        >
          {cards}
        </div>
      </Typography>
    );
  };

  return (
    <Box mt={4}>
      <Typography variant='h5' onClick={onClickHandler} aria-label="game-log-heading">Game & Transactions Log:</Typography>
      <br />
      <Paper
        elevation={1}
        style={{ maxHeight: '800px', overflow: 'auto', padding: '8px' }}
      >
        {log.map((entry, index) => {
          const iWin = entry.topLineOutcome == 'win' ? 'WINNER' : '';
          let opWin = entry.topLineOutcome == 'lose' ? 'WINNER' : '';
          let myDivChildren = [
            <Typography
              aria-label={`log-entry-me-${index}`}
              key={index}
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'baseline',
              }}
            >
              {playerDisplay(true, entry.myHandDescription, entry.myHand)} {iWin}
            </Typography>
          ];
          let opDivChildren = [
            <Typography
              aria-label={`log-entry-opponent-${index}`}
              key={index}
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'baseline',
              }}
            >
              {playerDisplay(
                false,
                entry.opponentHandDescription,
                entry.opponentHand,
              )}{' '}
              {opWin}
            </Typography>
          ];
          if (logOpen) {
            myDivChildren.push(
              <Typography style={{ display: 'flex', flexDirection: 'row' }}>
                My Cards <div aria-label={`my-start-hand-${index}`}>{entry.myStartHand.map((c,i) => cardDisplay(c, i, 'my-cards', (entry.myPicks & (1 << i)) != 0))}</div>
              </Typography>
            );
            opDivChildren.push(
              <Typography style={{ display: 'flex', flexDirection: 'row' }}>
                My Cards <div aria-label={`opponent-start-hand-${index}`}>{entry.opponentStartHand.map((c,i) => cardDisplay(c, i, 'opponent-cards', (entry.opponentPicks & (1 << i)) != 0))}</div>
              </Typography>
            );
          }

          const children = [...myDivChildren, ...opDivChildren];
          return (<div>{children}</div>);
        })}
      </Paper>
    </Box>
  );
};

export default GameLog;
