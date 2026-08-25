import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

type AmountUnit = 'mojo' | 'xch';

function mojosToXch(mojos: bigint): string {
  const value = mojos.toString().padStart(13, '0');
  const whole = value.slice(0, -12).replace(/^0+/, '') || '0';
  const frac = value.slice(-12).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

function parseAmount(raw: string, unit: AmountUnit): bigint | null {
  if (/^\s*$/.test(raw)) return 0n;
  const value = raw.trim();
  if (unit === 'mojo') return /^\d+$/.test(value) ? BigInt(value) : null;
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole, frac = ''] = value.split('.');
  if (frac.length > 12) return null;
  return BigInt(whole + frac.padEnd(12, '0'));
}

export function AmountInput({
  valueMojos,
  onChange,
  maxMojos,
  onUseMax,
  disabled,
  label,
  exceedsLabel,
  onKeyDown,
}: {
  valueMojos: bigint;
  onChange: (mojos: bigint) => void;
  maxMojos?: bigint | null;
  onUseMax?: () => void;
  disabled?: boolean;
  label: string;
  exceedsLabel: string;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const [unit, setUnit] = useState<AmountUnit>('mojo');
  const [rawInput, setRawInput] = useState(() => valueMojos.toString());
  const lastExternalMojos = useRef(valueMojos);

  useEffect(() => {
    if (valueMojos === lastExternalMojos.current) return;
    lastExternalMojos.current = valueMojos;
    setRawInput(unit === 'xch' ? mojosToXch(valueMojos) : valueMojos.toString());
  }, [unit, valueMojos]);

  const parsed = parseAmount(rawInput, unit);
  const valid = parsed !== null && parsed > 0n;
  const exceeds = valid && maxMojos != null && parsed > maxMojos;
  const changeUnit = useCallback(
    (next: AmountUnit) => {
      if (next === unit) return;
      const current = parseAmount(rawInput, unit);
      setUnit(next);
      if (current !== null) setRawInput(next === 'xch' ? mojosToXch(current) : current.toString());
    },
    [rawInput, unit],
  );

  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <div className="flex flex-wrap items-center justify-center gap-2">
        <span className="text-xs text-canvas-text">{label}</span>
        <div className="flex rounded-md border border-canvas-border overflow-hidden text-xs">
          <button type="button" onClick={() => changeUnit('mojo')} className={`px-2 py-0.5 transition-colors ${unit === 'mojo' ? 'bg-canvas-bg-active font-semibold' : 'hover:bg-canvas-bg-hover'}`}>mojo</button>
          <button type="button" onClick={() => changeUnit('xch')} className={`px-2 py-0.5 transition-colors border-l border-canvas-border ${unit === 'xch' ? 'bg-canvas-bg-active font-semibold' : 'hover:bg-canvas-bg-hover'}`}>XCH</button>
        </div>
      </div>
      <input
        type="text"
        inputMode={unit === 'xch' ? 'decimal' : 'numeric'}
        value={rawInput}
        onChange={(event) => {
          const raw = event.target.value;
          setRawInput(raw);
          const next = parseAmount(raw, unit);
          if (next !== null && next > 0n) {
            lastExternalMojos.current = next;
            onChange(next);
          }
        }}
        onKeyDown={onKeyDown}
        disabled={disabled}
        className={`w-full rounded border px-2 py-1 text-center text-sm bg-canvas-bg-subtle text-canvas-text-contrast outline-none ${!valid && rawInput.trim() !== '' ? 'border-alert-solid' : 'border-canvas-line'}`}
      />
      {exceeds && (
        <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-alert-text">
          <span>{exceedsLabel}</span>
          {onUseMax && (
            <button
              type="button"
              onClick={() => {
                if (maxMojos == null) return;
                lastExternalMojos.current = maxMojos;
                setRawInput(unit === 'xch' ? mojosToXch(maxMojos) : maxMojos.toString());
                onChange(maxMojos);
                onUseMax();
              }}
              className="underline font-medium hover:text-alert-text-contrast transition-colors"
            >
              Use max ({unit === 'xch' ? `${mojosToXch(maxMojos!)} XCH` : `${maxMojos} mojos`})
            </button>
          )}
        </div>
      )}
    </div>
  );
}
