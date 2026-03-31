import { useState } from 'react';

interface UseDebugReturn {
  wcInfo: string;
  setWcInfo: (value: string) => void;
}

const useDebug = (): UseDebugReturn => {
  const [wcInfo, setWcInfo] = useState<string>('');
  return { wcInfo, setWcInfo };
};

export default useDebug;
