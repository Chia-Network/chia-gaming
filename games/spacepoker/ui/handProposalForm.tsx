import type { HandProposalFormProps } from '../../host';
import { AmountInput } from './AmountInput';
import { formatSpacepokerMojos } from './formatting';

export function HandProposalForm({
  draft,
  disabled,
  maxPerHandMojos,
  onChange,
  onSubmit,
}: HandProposalFormProps<{ unitSize: bigint; stackSize: bigint }>) {
  const betSize = draft.unitSize * draft.stackSize;
  const maxUnitSize =
    maxPerHandMojos != null && draft.stackSize > 0n ? maxPerHandMojos / draft.stackSize : null;
  return (
    <>
      <AmountInput
        valueMojos={draft.unitSize}
        onChange={(unitSize) => onChange({ unitSize })}
        maxMojos={maxUnitSize}
        onUseMax={
          maxUnitSize != null && maxUnitSize > 0n
            ? () => onChange({ unitSize: maxUnitSize })
            : undefined
        }
        disabled={disabled}
        label="Unit size"
        exceedsLabel="Exceeds available reserve."
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSubmit();
        }}
      />
      <div className="flex w-full flex-col items-center gap-1">
        <label className="text-xs font-medium text-canvas-text">Stack size (units per player)</label>
        <input
          type="number"
          min={1}
          className="w-full rounded border border-canvas-line bg-canvas-bg px-2 py-1 text-center text-sm text-canvas-text-contrast focus:outline-none focus:ring-1 focus:ring-canvas-solid"
          value={draft.stackSize.toString()}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value.replace(/[^0-9]/g, '');
            onChange({ stackSize: BigInt(next || '0') });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSubmit();
          }}
        />
      </div>
      <div className="text-xs text-canvas-text">
        Per-player stake: {formatSpacepokerMojos(betSize)} · Total game size:{' '}
        {formatSpacepokerMojos(betSize * 2n)}
      </div>
    </>
  );
}
