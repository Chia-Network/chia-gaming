import { useEffect, useId, useState } from 'react';
import { getCurrencyLabels } from '../constants/currency';
import {
  EXPEDITED_FEE_PER_COST,
  MINIMUM_FEE_PER_COST,
  openingFeeMojos,
  transactionFeeEstimate,
} from '../constants/fees';
import { Input } from './ui/input';

type Choice = 'minimum' | 'expedited' | 'custom';

function choiceFor(feePerCost: bigint): Choice {
  if (feePerCost === MINIMUM_FEE_PER_COST) return 'minimum';
  if (feePerCost === EXPEDITED_FEE_PER_COST) return 'expedited';
  return 'custom';
}

/** Zero turns fees off. Otherwise the network minimum applies. */
export function parseFeePerCost(raw: string): bigint | null {
  const trimmed = raw.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  const rate = BigInt(trimmed);
  return rate === 0n || rate >= MINIMUM_FEE_PER_COST ? rate : null;
}

/** XCH to six decimal places, enough to tell fee estimates apart. */
export function formatFeeXch(mojos: bigint): string {
  const millionths = (mojos + 500_000n) / 1_000_000n;
  const whole = millionths / 1_000_000n;
  const fraction = (millionths % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} ${getCurrencyLabels().xch}`;
}

export function FeeRateSetting({
  feePerCost,
  onChange,
}: {
  feePerCost: bigint;
  onChange: (feePerCost: bigint) => void;
}) {
  const id = useId();
  const [choice, setChoice] = useState<Choice>(() => choiceFor(feePerCost));
  const [custom, setCustom] = useState(() => feePerCost.toString());
  useEffect(() => {
    setChoice(choiceFor(feePerCost));
    setCustom(feePerCost.toString());
  }, [feePerCost]);
  const parsedCustom = parseFeePerCost(custom);
  const shown = choice === 'custom' ? (parsedCustom ?? feePerCost) : feePerCost;

  const choose = (next: Choice) => {
    setChoice(next);
    if (next === 'minimum') onChange(MINIMUM_FEE_PER_COST);
    else if (next === 'expedited') onChange(EXPEDITED_FEE_PER_COST);
  };
  const commitCustom = () => {
    if (parsedCustom !== null && parsedCustom !== feePerCost) onChange(parsedCustom);
  };

  return (
    <fieldset className="w-full max-w-xs text-sm text-canvas-text">
      <legend className="mb-1">Transaction fee, in mojos per cost</legend>
      <div role="radiogroup" className="grid gap-2">
        {(
          [
            ['minimum', `Minimum (${MINIMUM_FEE_PER_COST})`],
            ['expedited', `Expedited (${EXPEDITED_FEE_PER_COST})`],
            ['custom', 'Custom'],
          ] as const
        ).map(([value, label]) => (
          <div key={value} className="flex items-center gap-2">
            <input
              type="radio"
              id={`${id}-${value}`}
              name={id}
              value={value}
              checked={choice === value}
              onChange={() => choose(value)}
              className="size-4 accent-primary-solid"
            />
            <label htmlFor={`${id}-${value}`}>{label}</label>
            {value === 'custom' && choice === 'custom' && (
              <Input
                aria-label="Custom fee per cost"
                aria-invalid={parsedCustom === null || undefined}
                inputMode="numeric"
                className="h-7 w-20"
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
                onBlur={commitCustom}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitCustom();
                }}
              />
            )}
          </div>
        ))}
      </div>
      {choice === 'custom' && parsedCustom === null ? (
        <p className="mt-1 text-xs text-alert-text">
          Enter a whole number of at least {MINIMUM_FEE_PER_COST.toString()}, or 0 to turn fees off.
        </p>
      ) : shown === 0n ? (
        <p className="mt-1 text-xs">
          Fees are off. Most farmers leave transactions without a fee out of blocks.
        </p>
      ) : (
        <p className="mt-1 text-xs" aria-live="polite">
          About {formatFeeXch(openingFeeMojos(shown))} to open a session, and about{' '}
          {formatFeeXch(transactionFeeEstimate(shown))} for each later transaction, such as closing
          it.
        </p>
      )}
    </fieldset>
  );
}
