import { AmountInput, useGameHost } from '../../host/ui';
import type { ComposeEditorProps } from '../../host';
import { isValidKrunkStake } from './adapter';

export function KrunkComposeEditor({
  draft,
  disabled,
  maxPerHandMojos,
  onChange,
  onSubmit,
}: ComposeEditorProps<{ amount: bigint }>) {
  const { currencyLabels } = useGameHost();
  const maxMojos =
    maxPerHandMojos != null ? maxPerHandMojos - (maxPerHandMojos % 100n) : maxPerHandMojos;
  return (
    <>
      <AmountInput
        valueMojos={draft.amount}
        onChange={(amount) => onChange({ amount })}
        maxMojos={maxMojos}
        onUseMax={
          maxMojos != null && maxMojos > 0n ? () => onChange({ amount: maxMojos }) : undefined
        }
        disabled={disabled}
        label="Per-player stake"
        exceedsLabel="Exceeds available reserve."
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSubmit();
        }}
      />
      {draft.amount > 0n && !isValidKrunkStake(draft.amount) && (
        <p className="text-xs text-alert-text">
          Krunk stakes must be multiples of 100 {currencyLabels.mojos}.
        </p>
      )}
    </>
  );
}
