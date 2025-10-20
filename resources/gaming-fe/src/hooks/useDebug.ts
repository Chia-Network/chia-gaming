import { useState, useEffect, useRef } from "react";
//import io, { Socket } from "socket.io-client";

//export type GameState = "idle" | "searching" | "playing";

interface UseDebugReturn {
  wcInfo: string;
  setWcInfo: (value: string) => void;
}

const useDebug = (): UseDebugReturn => {
  const [wcInfo, setWcInfo] = useState<string>("");
  return { wcInfo, setWcInfo };
};

export default useDebug;
