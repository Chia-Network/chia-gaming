import React from 'react';

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


return(
  <div
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    onClick={closeDialog}
  >
    <div
      className="bg-canvas-bg text-canvas-text rounded-lg w-full max-w-lg p-6"
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
          placeholder="Buy-in (minimum 100 mojos)"
          className="w-full p-2 bg-canvas-bg text-canvas-text border border-canvas-line rounded placeholder-canvas-text-contrast"
        />
      </div>
      {wagerValidationError && (
        <p style={{ color: '#FF6F00', marginBottom: 1 }}>
          {"    " + wagerValidationError}
        </p>
      )}
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
        <button
          onClick={closeDialog}
          className="px-4 py-2 border border-secondary-solid text-secondary-solid rounded hover:bg-secondary-solid/10"
        >
          Cancel
        </button>
        <button
          onClick={handleCreate}
          className="px-4 py-2 bg-secondary-solid text-canvas-bg rounded hover:bg-secondary-solid/90"
        >
          Create
        </button>
      </div>
    </div>
  </div>
  );
};

export default CreateRoomDialog;
