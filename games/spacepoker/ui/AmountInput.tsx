import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

type Unit = 'mojo' | 'xch';
const toXch = (mojos: bigint) => {
  const value = mojos.toString().padStart(13, '0');
  const whole = value.slice(0, -12).replace(/^0+/, '') || '0';
  const frac = value.slice(-12).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
};
const parse = (raw: string, unit: Unit): bigint | null => {
  if (/^\s*$/.test(raw)) return 0n;
  const value = raw.trim();
  if (unit === 'mojo') return /^\d+$/.test(value) ? BigInt(value) : null;
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole, frac = ''] = value.split('.');
  return frac.length <= 12 ? BigInt(whole + frac.padEnd(12, '0')) : null;
};

export function AmountInput(props: {
  valueMojos: bigint;
  onChange: (value: bigint) => void;
  maxMojos?: bigint | null;
  onUseMax?: () => void;
  disabled?: boolean;
  label: string;
  exceedsLabel: string;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const [unit, setUnit] = useState<Unit>('mojo');
  const [raw, setRaw] = useState(() => props.valueMojos.toString());
  const external = useRef(props.valueMojos);
  useEffect(() => {
    if (props.valueMojos === external.current) return;
    external.current = props.valueMojos;
    setRaw(unit === 'xch' ? toXch(props.valueMojos) : props.valueMojos.toString());
  }, [props.valueMojos, unit]);
  const parsed = parse(raw, unit);
  const valid = parsed !== null && parsed > 0n;
  const exceeds = valid && props.maxMojos != null && parsed > props.maxMojos;
  const selectUnit = (next: Unit) => {
    if (next === unit) return;
    const current = parse(raw, unit);
    setUnit(next);
    if (current !== null) setRaw(next === 'xch' ? toXch(current) : current.toString());
  };
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <div className="flex flex-wrap items-center justify-center gap-2">
        <span className="text-xs text-canvas-text">{props.label}</span>
        <div className="flex rounded-md border border-canvas-border overflow-hidden text-xs">
          <button type="button" onClick={() => selectUnit('mojo')} className={`px-2 py-0.5 transition-colors ${unit === 'mojo' ? 'bg-canvas-bg-active font-semibold' : 'hover:bg-canvas-bg-hover'}`}>mojo</button>
          <button type="button" onClick={() => selectUnit('xch')} className={`px-2 py-0.5 transition-colors border-l border-canvas-border ${unit === 'xch' ? 'bg-canvas-bg-active font-semibold' : 'hover:bg-canvas-bg-hover'}`}>XCH</button>
        </div>
      </div>
      <input type="text" inputMode={unit === 'xch' ? 'decimal' : 'numeric'} value={raw} disabled={props.disabled} onKeyDown={props.onKeyDown}
        onChange={(event) => {
          setRaw(event.target.value);
          const next = parse(event.target.value, unit);
          if (next !== null && next > 0n) {
            external.current = next;
            props.onChange(next);
          }
        }}
        className={`w-full rounded border px-2 py-1 text-center text-sm bg-canvas-bg-subtle text-canvas-text-contrast outline-none ${!valid && raw.trim() !== '' ? 'border-alert-solid' : 'border-canvas-line'}`}
      />
      {exceeds && <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-alert-text">
        <span>{props.exceedsLabel}</span>
        {props.onUseMax && <button type="button" className="underline font-medium hover:text-alert-text-contrast transition-colors" onClick={() => {
          const max = props.maxMojos!;
          external.current = max;
          setRaw(unit === 'xch' ? toXch(max) : max.toString());
          props.onChange(max);
          props.onUseMax?.();
        }}>Use max ({unit === 'xch' ? `${toXch(props.maxMojos!)} XCH` : `${props.maxMojos} mojos`})</button>}
      </div>}
    </div>
  );
}
