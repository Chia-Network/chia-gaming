'use client';

import { Button } from '@/src/components/button';
import {
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Dialog,
} from '@/src/components/ui/dialog';
import CreateRoomDialog from '@/src/features/createRoom/CreateRoomDialog';
import { Box, LogOut, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';

interface EndGameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPlayAgain: () => void;
  onEndSession: () => void;
  disableEndSession?: boolean;
}

export function EndGameDialog({
  open,
  onOpenChange,
  onPlayAgain,
  onEndSession,
  disableEndSession = false,
}: EndGameDialogProps) {
  // Set default game choice
  // State for create room dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [gameChoice, setGameChoice] = useState('');
  const [wagerInput, setWagerInput] = useState('');
  const [perHandInput, setPerHandInput] = useState('');
  const [wagerValidationError, setWagerValidationError] = useState('');

  // Placeholder lobby games - you'll need to get this from your actual source
  const lobbyGames = [{ game: 'calpoker', displayName: 'Cal Poker' }];

  useEffect(() => {
    if (lobbyGames.length > 0 && !gameChoice) {
      setGameChoice(lobbyGames[0].game);
    }
  }, [lobbyGames, gameChoice]);

  const handleCreateClick = () => {
    setDialogOpen(true);
  };

  const handleCreate = () => {
    // Log the create room info for now
    console.log('Create Room Info:', {
      gameChoice,
      wagerInput,
      perHandInput,
    });

    // Close the dialog
    setDialogOpen(false);

    // TODO: Add actual functionality here later
    alert('Room creation logged to console. Functionality to be implemented.');
  };

  const setWagerInputWithCalculation = (newWagerInput: string) => {
    setWagerInput(newWagerInput);
    try {
      const newWagerInputInteger = parseInt(newWagerInput);
      setWagerValidationError('');
      const newPerHand = Math.max(1, Math.floor(newWagerInputInteger / 10));
      setPerHandInput(newPerHand.toString());
    } catch (e: any) {
      setWagerValidationError(`${e.toString()}`);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className='sm:max-w-2xl z-300 bg-canvas-bg-subtle'
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Hand Finished</DialogTitle>
          <DialogDescription>What would you like to do next?</DialogDescription>
        </DialogHeader>

        <DialogFooter className='flex gap-2 sm:gap-0'>
          <Button
            variant='soft'
            onClick={() => {
              onPlayAgain();
              onOpenChange(false);
            }}
            className='w-full sm:w-auto text-xs!'
            leadingIcon={<RotateCcw />}
          >
            Play Another Hand
          </Button>

          <Button variant='surface' color='primary' onClick={handleCreateClick}>
            Create New Room
          </Button>
          {/* <Button
            data-testid="end-session-dialog-button"
            variant='destructive'
            onClick={() => {
              onEndSession();
              onOpenChange(false);
            }}
            disabled={disableEndSession}
            className='w-full sm:w-auto text-xs!'
            leadingIcon={<LogOut />}
          >
            End Session
          </Button> */}
        </DialogFooter>
      </DialogContent>
      <CreateRoomDialog
        dialogOpen={dialogOpen}
        closeDialog={() => setDialogOpen(false)}
        gameChoice={gameChoice}
        setGameChoice={setGameChoice}
        lobbyGames={lobbyGames}
        wagerInput={wagerInput}
        setWagerInput={setWagerInputWithCalculation}
        perHandInput={perHandInput}
        setPerHandInput={setPerHandInput}
        wagerValidationError={wagerValidationError}
        handleCreate={handleCreate}
      />
    </Dialog>
  );
}
