import {Button} from './button'
import React from 'react';
//import { useWalletConnect } from "../hooks/WalletConnectContext";

interface DebugProps {
  connectString: string;
  setConnectString: (value: string) => void;
}

{
  /*
const onConnect = () => {
    if (!client) throw new Error('WalletConnect is not initialized.');

    if (pairings.length === 1) {
        connect({ topic: pairings[0].topic });
    } else if (pairings.length) {
        console.log('The pairing modal is not implemented.', pairings);
    } else {
        connect();
    }
};
*/
}

//const onSetConnectString = () => { 0; }
// const setWCStringButtonHandler = () => { 0; }
const setWCStringButtonHandler = () => void 0;

// Rename: DebugPanel, DebugSection ...
const Debug: React.FC<DebugProps> = ({ connectString, setConnectString }) => {
  return (
    <div className='flex flex-col gap-3 w-full'>
      {/* Connect String Input */}
      <div className='flex flex-col w-full'>
        <label className='mb-1 text-sm font-medium text-gray-700'>
          Connect String
        </label>
        <input
          type='text'
          value={connectString}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setConnectString(e.target.value)
          }
          placeholder='e.g. wc:ffffff....'
          className='w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500'
        />
      </div>

      {/* Set WC String Button */}
      <Button
        variant={'solid'}
        color={'secondary'}
        onClick={setWCStringButtonHandler}
        fullWidth
      >
        Set WC string
      </Button>

      {/* Optional Link Wallet button (commented out) */}
      {/*
      <Button
        variant={'solid'}
        color={'primary'}
        onClick={onConnect}
        fullWidth
      >
        Link Wallet
      </Button>
      */}
    </div>
  );
};

export default Debug;
