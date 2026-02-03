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
import { LogOut, RotateCcw } from 'lucide-react';

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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className='sm:max-w-2xl z-300 bg-canvas-bg-subtle [&>button]:hidden'
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

          <Button
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
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
