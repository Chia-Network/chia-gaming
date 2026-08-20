import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  DEFAULT_CURRENCY_LABELS,
  defaultFormatAmount,
  defaultFormatMojos,
  gameHandState,
  type CurrencyLabels,
  type GameHandSource,
  type PersistedGameState,
} from './index';

export interface GameHostServices {
  formatAmount(mojos: bigint): string;
  formatMojos(mojos: bigint): string;
  currencyLabels: CurrencyLabels;
}

const DEFAULT_HOST_SERVICES: GameHostServices = {
  formatAmount: defaultFormatAmount,
  formatMojos: defaultFormatMojos,
  currencyLabels: DEFAULT_CURRENCY_LABELS,
};

const GameHostContext = createContext<GameHostServices>(DEFAULT_HOST_SERVICES);

export function GameHostProvider({
  services,
  children,
}: {
  services: GameHostServices;
  children: ReactNode;
}) {
  return <GameHostContext.Provider value={services}>{children}</GameHostContext.Provider>;
}

export function useGameHost(): GameHostServices {
  return useContext(GameHostContext);
}

export function useInitialGameHandState(
  source: GameHandSource,
): Readonly<PersistedGameState> | null {
  const [initial] = useState(() => gameHandState(source));
  return initial;
}

export function useCheatNerfKeys(
  handleCheat: () => void,
  handleNerf: () => void,
  enabled = true,
): void {
  const cheatBufRef = useRef('');
  const nerfBufRef = useRef('');
  useEffect(() => {
    if (!enabled) return;
    const CHEAT_SEQ = 'cheat^';
    const NERF_SEQ = 'nerf^';
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key.length !== 1) return;

      const cheatBuf = cheatBufRef.current + e.key;
      if (CHEAT_SEQ.startsWith(cheatBuf)) {
        cheatBufRef.current = cheatBuf;
        if (cheatBuf === CHEAT_SEQ) {
          cheatBufRef.current = '';
          handleCheat();
        }
      } else {
        cheatBufRef.current = CHEAT_SEQ.startsWith(e.key) ? e.key : '';
      }

      const nerfBuf = nerfBufRef.current + e.key;
      if (NERF_SEQ.startsWith(nerfBuf)) {
        nerfBufRef.current = nerfBuf;
        if (nerfBuf === NERF_SEQ) {
          nerfBufRef.current = '';
          handleNerf();
        }
      } else {
        nerfBufRef.current = NERF_SEQ.startsWith(e.key) ? e.key : '';
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, handleCheat, handleNerf]);
}

function mojosToXchStr(mojos: bigint): string {
  const s = mojos.toString().padStart(13, '0');
  const whole = s.slice(0, -12).replace(/^0+/, '') || '0';
  const frac = s.slice(-12).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

function parseMojoInput(raw: string): bigint | null {
  if (/^\s*$/.test(raw)) return 0n;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  try {
    const n = BigInt(trimmed);
    return n >= 0n ? n : null;
  } catch {
    return null;
  }
}

function parseXchInput(raw: string): bigint | null {
  if (/^\s*$/.test(raw)) return 0n;
  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, frac = ''] = trimmed.split('.');
  if (frac.length > 12) return null;
  const mojoStr = whole + frac.padEnd(12, '0');
  try {
    const mojos = BigInt(mojoStr);
    return mojos >= 0n ? mojos : null;
  } catch {
    return null;
  }
}

type AmountUnit = 'mojo' | 'xch';

export interface AmountInputProps {
  valueMojos: bigint;
  onChange: (mojos: bigint) => void;
  maxMojos?: bigint | null;
  onUseMax?: () => void;
  disabled?: boolean;
  label?: string;
  exceedsLabel?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}

export function AmountInput({
  valueMojos,
  onChange,
  maxMojos,
  onUseMax,
  disabled,
  label = 'Amount',
  exceedsLabel = 'Exceeds available balance.',
  onKeyDown,
}: AmountInputProps) {
  const { currencyLabels: labels } = useGameHost();
  const [unit, setUnit] = useState<AmountUnit>('mojo');
  const [rawInput, setRawInput] = useState(() => valueMojos.toString());
  const lastExternalMojos = useRef(valueMojos);

  useEffect(() => {
    if (valueMojos !== lastExternalMojos.current) {
      lastExternalMojos.current = valueMojos;
      setRawInput(unit === 'xch' ? mojosToXchStr(valueMojos) : valueMojos.toString());
    }
  }, [valueMojos, unit]);

  const parseInput = useCallback(
    (raw: string): bigint | null => (unit === 'xch' ? parseXchInput(raw) : parseMojoInput(raw)),
    [unit],
  );

  const parsedMojos = parseInput(rawInput);
  const isValid = parsedMojos !== null && parsedMojos > 0n;
  const exceeds = isValid && maxMojos != null && parsedMojos! > maxMojos;

  const handleChange = useCallback(
    (raw: string) => {
      setRawInput(raw);
      const mojos = unit === 'xch' ? parseXchInput(raw) : parseMojoInput(raw);
      if (mojos !== null && mojos > 0n) {
        lastExternalMojos.current = mojos;
        onChange(mojos);
      }
    },
    [unit, onChange],
  );

  const handleUnitChange = useCallback(
    (newUnit: AmountUnit) => {
      if (newUnit === unit) return;
      const currentMojos = parseInput(rawInput);
      setUnit(newUnit);
      if (currentMojos !== null) {
        setRawInput(newUnit === 'xch' ? mojosToXchStr(currentMojos) : currentMojos.toString());
      }
    },
    [unit, rawInput, parseInput],
  );

  const handleUseMax = useCallback(() => {
    if (maxMojos == null) return;
    lastExternalMojos.current = maxMojos;
    setRawInput(unit === 'xch' ? mojosToXchStr(maxMojos) : maxMojos.toString());
    onChange(maxMojos);
    onUseMax?.();
  }, [maxMojos, unit, onChange, onUseMax]);

  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <div className="flex flex-wrap items-center justify-center gap-2">
        <span className="text-xs text-canvas-text">{label}</span>
        <div className="flex rounded-md border border-canvas-border overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => handleUnitChange('mojo')}
            className={`px-2 py-0.5 transition-colors ${unit === 'mojo' ? 'bg-canvas-bg-active font-semibold' : 'hover:bg-canvas-bg-hover'}`}
          >
            {labels.mojo}
          </button>
          <button
            type="button"
            onClick={() => handleUnitChange('xch')}
            className={`px-2 py-0.5 transition-colors border-l border-canvas-border ${unit === 'xch' ? 'bg-canvas-bg-active font-semibold' : 'hover:bg-canvas-bg-hover'}`}
          >
            {labels.xch}
          </button>
        </div>
      </div>
      <input
        type="text"
        inputMode={unit === 'xch' ? 'decimal' : 'numeric'}
        value={rawInput}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        className={`w-full rounded border px-2 py-1 text-center text-sm bg-canvas-bg-subtle text-canvas-text-contrast outline-none ${
          !isValid && rawInput.trim() !== '' ? 'border-alert-solid' : 'border-canvas-line'
        }`}
      />
      {exceeds && (
        <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-alert-text">
          <span>{exceedsLabel}</span>
          {onUseMax !== undefined && (
            <button
              type="button"
              onClick={handleUseMax}
              className="underline font-medium hover:text-alert-text-contrast transition-colors"
            >
              Use max (
              {unit === 'xch'
                ? `${mojosToXchStr(maxMojos!)} ${labels.xch}`
                : `${maxMojos!.toString()} ${labels.mojos}`}
              )
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export { mojosToXchStr, parseMojoInput, parseXchInput };
export type { AmountUnit };
