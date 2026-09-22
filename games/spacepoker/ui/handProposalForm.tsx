import { forwardRef, useImperativeHandle, useState } from 'react';
import type { GameProposalFormHandle, HandProposalFormProps } from '../../host';
import { AmountInput } from './AmountInput';
import { formatSpacepokerMojos } from './formatting';
import type { SpacepokerFactoryParameters } from './unitSize';

export const HandProposalForm = forwardRef<
  GameProposalFormHandle<SpacepokerFactoryParameters>,
  HandProposalFormProps<SpacepokerFactoryParameters>
>(function HandProposalForm(
  { disabled, maxPerHandMojos, defaultContribution, initialValues, onSubmit },
  ref,
) {
  const initialParams = initialValues?.parameters ?? null;
  const [betUnitMojos, setBetUnitMojos] = useState(initialParams?.betUnitMojos ?? 1n);
  const [stackSize, setStackSize] = useState(
    initialParams?.stackSize ??
      (defaultContribution > 0n && betUnitMojos > 0n ? defaultContribution / betUnitMojos : 10n),
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const betSize = betUnitMojos * stackSize;
  const maxUnitSize =
    maxPerHandMojos != null && stackSize > 0n ? maxPerHandMojos / stackSize : null;
  useImperativeHandle(ref, () => ({
    getProposal: () => {
      const error =
        betUnitMojos <= 0n || stackSize < 0n
          ? 'Minimum raise must be positive and stack size cannot be negative.'
          : stackSize > 0n && maxPerHandMojos !== null && betSize > maxPerHandMojos
            ? 'Per-player stake exceeds the available reserve.'
            : null;
      setValidationError(error);
      return error
        ? { ok: false, error }
        : {
            ok: true,
            parameters: { stackSize, betUnitMojos },
          };
    },
  }));
  return (
    <>
      <AmountInput
        valueMojos={betUnitMojos}
        onChange={setBetUnitMojos}
        maxMojos={maxUnitSize}
        onUseMax={
          maxUnitSize != null && maxUnitSize > 0n
            ? () => setBetUnitMojos(maxUnitSize)
            : undefined
        }
        disabled={disabled}
        label="Minimum raise"
        exceedsLabel="Exceeds available reserve."
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSubmit();
        }}
      />
      <div className="flex w-full flex-col items-center gap-1">
        <label className="text-xs font-medium text-canvas-text">Stack size (units per player)</label>
        <input
          type="number"
          min={0}
          className="w-full rounded border border-canvas-line bg-canvas-bg px-2 py-1 text-center text-sm text-canvas-text-contrast focus:outline-none focus:ring-1 focus:ring-canvas-solid"
          value={stackSize.toString()}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value.replace(/[^0-9]/g, '');
            setStackSize(BigInt(next || '0'));
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSubmit();
          }}
        />
      </div>
      <div className="text-xs text-canvas-text">
        {stackSize === 0n ? (
          <>No limit · stake resolves from both reserves when accepted</>
        ) : (
          <>
            Per-player stake: {formatSpacepokerMojos(betSize)} · Total game size:{' '}
            {formatSpacepokerMojos(betSize * 2n)}
          </>
        )}
      </div>
      {validationError && <p className="text-xs text-alert-text">{validationError}</p>}
    </>
  );
});
