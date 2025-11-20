import { Edit, Cross, User, Crown } from 'lucide-react';
import { Dispatch, SetStateAction } from 'react';

import { Player } from '../../types/lobby';

type PlayerForUI = Pick<Player, 'id' | 'alias'>;

interface ConnectedPlayersProps {
  splitPct: number;
  editingAlias: boolean;
  myAlias: string;
  setMyAlias: Dispatch<SetStateAction<string>>;
  commitEdit: (e: any) => void;
  setEditingAlias: Dispatch<SetStateAction<boolean>>;
  players: PlayerForUI[];
  uniqueId: string;
}

export default function ConnectedPlayers({
  splitPct,
  editingAlias,
  myAlias,
  setMyAlias,
  commitEdit,
  setEditingAlias,
  players,
  uniqueId,
}: ConnectedPlayersProps) {
  return (
    <div
      className='
        flex flex-col shrink-0
        bg-canvas-bg border-none shadow-none
        rounded-tr-2xl
      '
      style={{ flexBasis: `${splitPct}%` }}
    >
      <div className='flex flex-col h-full min-h-0 p-4'>
        {/* Connected Players Header */}
        <div className='flex flex-row justify-between items-center mb-3'>
          <h6 className='text-lg font-semibold text-canvas-text-contrast'>
            Connected Players
          </h6>
        </div>

        <div className='border-b border-canvas-line mb-2' />

        {/* Players Scroll */}
        <div className='flex-1 overflow-y-auto pr-1'>
          {editingAlias ? (
            <div className='flex flex-col sm:flex-row gap-2 mb-3'>
              <input
                aria-label='alias-input'
                className='w-full px-3 py-2 rounded bg-canvas-bg text-canvas-text border border-canvas-border outline-none '
                placeholder='Enter new alias'
                value={myAlias}
                onChange={(e) => setMyAlias(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && commitEdit(e)}
                onBlur={commitEdit}
              />

              <button
                onClick={commitEdit}
                aria-label='save-alias'
                className='px-4 py-2 rounded bg-secondary text-white font-medium'
              >
                Save
              </button>

              <button
                onClick={() => setEditingAlias(false)}
                className='w-8 h-8 flex items-center justify-center text-red-500'
              >
                <Cross className='w-5 h-5' />
              </button>
            </div>
          ) : (
            <div className='flex flex-row items-center gap-2 mb-2'>
              <p className='text-canvas-text'>
                Alias:&nbsp;
                <strong className='text-canvas-text-contrast font-bold'>
                  {myAlias}
                </strong>
              </p>

              <button
                aria-label='edit-alias'
                onClick={() => setEditingAlias(true)}
                className='text-canvas-solid w-6 h-6 flex items-center justify-center'
              >
                <Edit className='w-4 h-4' />
              </button>
            </div>
          )}

          {/* No Players */}
          {players.length === 0 ? (
            <div className='text-center py-6 text-canvas-text'>
              <User
                className='mx-auto mb-1'
                style={{
                  fontSize: 48,
                  color: 'var(--color-canvas-solid)',
                }}
              />
              <h6 className='text-lg font-medium text-canvas-text-contrast'>
                No Other Players Connected
              </h6>
              <p className='text-sm text-canvas-text'>
                Waiting for others to join…
              </p>
            </div>
          ) : (
            <div>
              {players.map((player, index) => (
                <p key={player.id} className='text-sm text-canvas-text mb-1'>
                  {index + 1}:&nbsp;
                  {player.id === uniqueId ? (
                    <span className='inline-flex items-center gap-1'>
                      {player.alias} (You)
                      <Crown
                        className='w-5 h-5 '
                        style={{ color: 'var(-warning-solid)' }}
                      />
                    </span>
                  ) : (
                    player.alias
                  )}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
