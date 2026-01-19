import React, { useState, useEffect, useCallback } from 'react';

import { ErrorBoundary } from './ErrorBoundary';
import CaliforniaPoker from '../features/calPoker/components';
import { QRCodeModal } from './QRCodeModal';
import WaitingScreen from './WaitingScreen';
import { WalletConnectDialog } from './WalletConnect';
import WalletConnectHeading from './WalletConnectHeading';
import Calpoker from '../features/calPoker';
// import {
//   OpponentSection,
//   PlayerSection,
//   PlayingCard,
// } from '../features/calPoker/components';
import GameLog from './GameLog';

const componentList: Record<string, any> = {
  BramVibe1: CaliforniaPoker as any,
  Calpoker: Calpoker as any,
  // PlayerSection: PlayerSection as any,
  // OpponentSection: OpponentSection as any,
  GameLog: GameLog as any,
  WaitingScreen: WaitingScreen as any,
  // PlayingCard: PlayingCard as any,
  QRCodeModal: QRCodeModal as any,
  WalletConnectHeading: WalletConnectHeading as any,
  WalletConnect: WalletConnectDialog as any,
};

const Gallery: React.FC = () => {
  const choiceFromStorage = localStorage.getItem('galleryChoice');
  const dataFromStorage = localStorage.getItem('galleryData');

  const [generation, setGeneration] = useState(0);
  const [arraySelection, setArraySelection] = useState<number>(0);
  const [componentChoice, setComponentChoice] = useState<string | undefined>(
    choiceFromStorage ? choiceFromStorage : undefined,
  );
  const [componentData, setComponentData] = useState<any | undefined>(
    dataFromStorage ? dataFromStorage : undefined,
  );
  const [functionCalls, setFunctionCalls] = useState<string[]>([]);

  const storeComponentChoice = useCallback(
    (evt: any) => {
      setComponentChoice(evt.target.value);
      localStorage.setItem('galleryChoice', evt.target.value);
      setFunctionCalls([]);
      setGeneration(generation + 1);
    },
    [generation],
  );
  const storeComponentData = useCallback(
    (evt: any) => {
      setComponentData(evt.target.value);
      localStorage.setItem('galleryData', evt.target.value);
      setFunctionCalls([]);
      setGeneration(generation + 1);
    },
    [generation],
  );

  let componentDataDecoded: any = undefined;
  let decodeError = undefined;

  if (componentData) {
    try {
      componentDataDecoded = JSON.parse(componentData);
    } catch (e: any) {
      decodeError = e.toString();
    }
  }

  useEffect(() => {
    const interval = setInterval(() => {
      if (componentDataDecoded && componentDataDecoded.length) {
        setArraySelection((arraySelection + 1) % componentDataDecoded.length);
      }
    }, 500);

    return () => {
      clearInterval(interval);
    };
  }, [arraySelection, componentDataDecoded]);

  const choiceList = [undefined, ...Object.keys(componentList)];
  const componentContainerStyle: Record<string, string> = {
    background: 'white',
    width: '90%',
    height: '90%',
    padding: '2em',
  };

  const composeError = (decodeError: string) => {
    return <div style={{ color: 'red' }}>{decodeError}</div>;
  };

  let component = undefined;

  try {
    const useComponentData =
      componentDataDecoded && componentDataDecoded.length
        ? componentDataDecoded[arraySelection % componentDataDecoded.length]
        : componentDataDecoded;
    ['height', 'width'].forEach((v) => {
      if (useComponentData && useComponentData[v] !== undefined) {
        componentContainerStyle[v] = useComponentData[v];
      }
    });
    Object.keys(useComponentData).forEach((k) => {
      if (componentDataDecoded[k] === '*function') {
        componentDataDecoded[k] = (...args: any[]) => {
          setFunctionCalls([...functionCalls, `${k}:${JSON.stringify(args)}`]);
        };
      }
    });

    component = decodeError ? (
      composeError(decodeError)
    ) : componentChoice && useComponentData ? (
      React.createElement(componentList[componentChoice], useComponentData)
    ) : (
      <div />
    );
  } catch (e: any) {
    component = composeError(e.toString());
  }

  const body = (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        width: '100vw',
        height: '100vh',
        flexGrow: 1,
        flexShrink: 1,
        background: '#888',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={componentContainerStyle}>{component}</div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          flexGrow: 0,
          flexShrink: 0,
          width: '100%',
          height: '3em',
          marginLeft: '2em',
          marginRight: '2em',
          alignItems: 'center',
        }}
      >
        <div>Component:</div>
        <select value={componentChoice} onChange={storeComponentChoice}>
          {choiceList.map((c) =>
            c === undefined ? (
              <option value=''>No selection</option>
            ) : (
              <option value={c}>{c}</option>
            ),
          )}
        </select>
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          flexGrow: 0,
          flexShrink: 0,
          width: '100%',
          height: '5em',
          padding: '2em',
          alignItems: 'center',
        }}
      >
        <div>Data:</div>
        <textarea
          style={{ width: '100%', height: '4em' }}
          value={componentData}
          onChange={storeComponentData}
        />
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          flexGrow: 0,
          flexShrink: 0,
          width: '100%',
          height: '5em',
          padding: '2em',
          alignItems: 'center',
        }}
      >
        <div>Calls:</div>
        <textarea
          style={{ width: '100%', height: '4em' }}
          value={functionCalls.join('\n')}
        />
      </div>
      <ErrorBoundary
        rerender={() =>
          storeComponentChoice({ target: { value: componentChoice } })
        }
      >
        <div
          style={{ position: 'relative', width: '0', height: 0, opacity: '0%' }}
        >
          {generation}
        </div>
        {body}
      </ErrorBoundary>
    </div>
  );
};

export default Gallery;
