import React, { cloneElement, useState, useEffect, useCallback } from "react";
import LobbyScreen from "./LobbyScreen";
import PlayerSection from "./PlayerSection";
import OpponentSection from "./OpponentSection";
import GameEndPlayer from "./GameEndPlayer";
import GameLog from "./GameLog";
import WaitingScreen from "./WaitingScreen";
import PlayingCard from "./PlayingCard";
import { QRCodeModal } from "./QRCodeModal";
import WalletConnectHeading from "./WalletConnectHeading";
import { WalletConnectDialog } from "./WalletConnect";

const componentList: Record<string, any> = {
  "LobbyScreen": LobbyScreen as any,
  "PlayerSection": PlayerSection as any,
  "OpponentSection": OpponentSection as any,
  "GameEndPlayer": GameEndPlayer as any,
  "GameLog": GameLog as any,
  "WaitingScreen": WaitingScreen as any,
  "PlayingCard": PlayingCard as any,
  "QRCodeModal": QRCodeModal as any,
  "WalletConnectHeading": WalletConnectHeading as any,
  "WalletConnect": WalletConnectDialog as any,
};

const Gallery: React.FC = () => {
  let [componentChoice, setComponentChoice] = useState<string | undefined>();
  let [componentData, setComponentData] = useState<any | undefined>();

  let componentDataDecoded: any = undefined;
  let decodeError = undefined;

  if (componentData) {
    try {
      componentDataDecoded = JSON.parse(componentData);
    } catch (e: any) {
      decodeError = e.toString();
    }
  }

  const choiceList = [undefined, ...Object.keys(componentList)];
  const componentContainerStyle: Record<string, string> = {
    background: "white",
    width: "90%",
    height: "90%"
  };

  ["height", "width"].forEach((v) => {
    if (componentDataDecoded && componentDataDecoded[v] !== undefined) {
      componentContainerStyle[v] = componentDataDecoded[v];
    }
  });

  const component = (componentChoice && componentDataDecoded) ? componentList[componentChoice](componentDataDecoded) : (<div/>);
  const body = decodeError ? (<div style={{ color: "red" }}>{decodeError}</div>) : (
    <div style={{ display: "flex", flexDirection: "row", width: "100vw", height: "100vh", flexGrow: 1, flexShrink: 1, background: "#888", alignItems: "center", justifyContent: "center" }}>
      <div style={componentContainerStyle}>
        {component}
                                                                                          </div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", flexDirection: "row", flexGrow: 0, flexShrink: 0, width: "100%", height: "3em" }}>
        <select onChange={(evt) => setComponentChoice(evt.target.value)}>
          {choiceList.map((c) => c === undefined ? (<option value="">No selection</option>) : (<option value={c}>{c}</option>))}
        </select>
      </div>
      <div style={{ display: "flex", flexDirection: "row", flexGrow: 0, flexShrink: 0, width: "100%", height: "5em" }}>
        <textarea value={componentData} onChange={(evt) => setComponentData(evt.target.value)} />
      </div>
      {body}
    </div>
  );
};

export default Gallery;
