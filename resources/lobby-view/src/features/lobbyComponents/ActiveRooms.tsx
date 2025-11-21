import { Gamepad } from 'lucide-react';
import { Dispatch, SetStateAction } from 'react';

interface Room {
  token: string;
  host: string;
  game: string;
}

interface ActiveRoomsProps {
  rooms: Room[];
  openDialog: () => void;
  joinRoom: (token: string) => void;
  getPlayerAlias: (id: string) => string;
}

export default function ActiveRooms({
  rooms,
  openDialog,
  joinRoom,
  getPlayerAlias,
}: ActiveRoomsProps) {
  return (
    <div className='flex w-full md:w-2/3 pr-0 h-full'>
      {/* Card */}
      <div className='bg-canvas-bg w-full rounded-l-xl h-full shadow-none border-none'>
        <div className='h-full pb-24 flex flex-col'>
          {/* Header */}
          <div className='flex flex-col sm:flex-row justify-between items-start sm:items-center gap-1 p-4'>
            <h6 className='text-lg font-semibold text-canvas-text-contrast'>
              Active Rooms
            </h6>
            <button
              onClick={openDialog}
              aria-label='generate-room'
              className='px-4 py-2 bg-secondary text-white rounded font-medium'
            >
              Generate Room
            </button>
          </div>

          <div className='border-b border-canvas-line mb-3'></div>

          {/* Rooms Scroll */}
          <div className='overflow-y-auto h-full pr-2 pb-24'>
            {rooms.length === 0 ? (
              <div className='text-center py-24 text-canvas-text'>
                <Gamepad
                  className='mx-auto mb-1'
                  style={{
                    fontSize: 48,
                    color: 'var(--color-canvas-solid)',
                  }}
                />
                <h6 className='text-lg font-medium text-canvas-text-contrast'>
                  No Active Rooms
                </h6>
                <p className='text-sm text-canvas-text'>
                  Create a room to start a game.
                </p>
              </div>
            ) : (
              rooms.map((r) => (
                <div
                  key={r.token}
                  className='p-2 mb-1.5 rounded border border-canvas-line bg-canvas-bg flex flex-col sm:flex-row justify-between items-start sm:items-center gap-1'
                >
                  <div>
                    <h6 className='text-sm font-semibold text-canvas-text-contrast'>
                      {r.token || 'Unknown Game'}
                    </h6>
                    <p className='text-sm text-canvas-text'>
                      Host: {getPlayerAlias(r.host)}
                    </p>
                    <p className='text-sm text-canvas-text'>Game: {r.game}</p>
                  </div>
                  <button
                    onClick={() => joinRoom(r.token)}
                    className='px-3 py-1 bg-secondary text-white rounded font-medium'
                  >
                    Join
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
