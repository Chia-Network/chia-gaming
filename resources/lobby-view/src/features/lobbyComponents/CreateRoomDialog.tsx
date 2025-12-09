import React from 'react';
import { Button } from '../../button';

interface CreateRoomDialogProps {
  dialogOpen: boolean;
  closeDialog: () => void;
  gameChoice: string;
  setGameChoice: (value: string) => void;
  lobbyGames: { game: string }[];
  wagerInput: string;
  setWagerInput: (value: string) => void;
  perHandInput: string;
  setPerHandInput: (value: string) => void;
  wagerValidationError?: string;
  handleCreate: () => void;
}

const CreateRoomDialog: React.FC<CreateRoomDialogProps> = ({
  dialogOpen,
  closeDialog,
  gameChoice,
  setGameChoice,
  lobbyGames,
  wagerInput,
  setWagerInput,
  perHandInput,
  setPerHandInput,
  wagerValidationError,
  handleCreate,
}) => {
  if (!dialogOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas-bg-subtle/75"
      onClick={closeDialog}
    >
      <div
        className="bg-canvas-bg-subtle text-canvas-text shadow-2xl rounded-lg w-full max-w-lg p-6"
        onClick={(e) => e.stopPropagation()} // prevent closing when clicking inside
      >
        {/* Title */}
        <h2 className="text-xl font-bold mb-4">Create a Room</h2>

        {/* Game Select */}
        <div className="mb-4">
          <label className="block mb-1 font-medium">Game</label>
          <select
            value={gameChoice}
            onChange={(e) => setGameChoice(e.target.value)}
            className="w-full p-2 bg-canvas-bg text-canvas-text border border-canvas-line rounded"
          >
            {lobbyGames.map((g) => (
              <option key={g.game} value={g.game} data-testid={`choose-${g.game}`}>
                {g.game}
              </option>
            ))}
          </select>
        </div>

        {/* Wager Validation Error */}
        {wagerValidationError && (
          <div className="mb-1 text-secondary-solid">{wagerValidationError}</div>
        )}

        {/* Wager Input */}
        <div className="mb-4">
          <label className="block mb-1 font-medium">Wager (mojo)</label>
          <input
            type="number"
            value={wagerInput}
            onChange={(e) => setWagerInput(e.target.value)}
            placeholder="Enter wager"
            className="w-full p-2 bg-canvas-bg text-canvas-text border border-canvas-line rounded placeholder-canvas-text-contrast"
          />
        </div>

        {/* Each Hand Input */}
        <div className="mb-4">
          <label className="block mb-1 font-medium">Each hand (mojo)</label>
          <input
            type="number"
            value={perHandInput}
            onChange={(e) => setPerHandInput(e.target.value)}
            placeholder="Enter per hand"
            className="w-full p-2 bg-canvas-bg text-canvas-text border border-canvas-line rounded placeholder-canvas-text-contrast"
          />
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 mt-4">
          <Button
            variant={'outline'}
            color={'secondary'}
            onClick={closeDialog}
          >
            Cancel
          </Button>
          <Button
            variant={'solid'}
            color={'secondary'}
            onClick={handleCreate}
            className="px-4 py-2 bg-secondary-solid text-canvas-bg rounded hover:bg-secondary-solid/90"
          >
            Create
          </Button>
        </div>
      </div>
    </div>
  );
};

export default CreateRoomDialog;
