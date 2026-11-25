import React from 'react';

import { CaliforniaPoker } from './components';
import { cardDeck, CardDeckProvider } from '../../host/cards/decks';
import { CalpokerDisplaySnapshotView, CalpokerOutcomeView } from './types/CaliforniapokerProps';
import type { SettlementOutcome } from '../../host';
import type { CalpokerError } from './serialize';

export interface CalpokerProps {
  outcome: CalpokerOutcomeView | undefined;
  moveNumber: string;
  playerNumber: number;
  playerHand: string[];
  opponentHand: string[];
  cardSelections: string[];
  setCardSelections: (n: string[] | ((prev: string[]) => string[])) => void;
  setHandOrder: (playerHand: string[], opponentHand?: string[]) => void;
  handleMakeMove: () => void;
  onGameLog: (lines: string[]) => void;
  onSnapshotChange: (snapshot: CalpokerDisplaySnapshotView) => void;
  initialSnapshot?: CalpokerDisplaySnapshotView;
  myName?: string;
  opponentName?: string;
  terminalOutcome?: SettlementOutcome | null;
  frozen?: boolean;
  error: CalpokerError | null;
  deckId?: string;
}

const Calpoker: React.FC<CalpokerProps> = ({
  outcome,
  moveNumber,
  playerNumber,
  playerHand,
  opponentHand,
  cardSelections,
  setCardSelections,
  setHandOrder,
  handleMakeMove,
  onGameLog,
  onSnapshotChange,
  initialSnapshot,
  myName,
  opponentName,
  terminalOutcome,
  frozen = false,
  error,
  deckId,
}) => {
  return (
    <CardDeckProvider value={cardDeck(deckId)}>
      <div className="relative flex h-full w-full min-h-0 flex-col">
        {/* Game area */}
        <div className="flex-1 min-h-0 flex flex-col">
          <CaliforniaPoker
            playerNumber={playerNumber}
            moveNumber={moveNumber}
            playerHand={playerHand}
            opponentHand={opponentHand}
            cardSelections={cardSelections}
            setCardSelections={setCardSelections}
            setHandOrder={setHandOrder}
            handleMakeMove={handleMakeMove}
            outcome={outcome}
            onGameLog={onGameLog}
            onSnapshotChange={onSnapshotChange}
            initialSnapshot={initialSnapshot}
            myName={myName}
            opponentName={opponentName}
            terminalOutcome={terminalOutcome}
            frozen={frozen}
            error={error}
          />
        </div>
      </div>
    </CardDeckProvider>
  );
};

export default Calpoker;
