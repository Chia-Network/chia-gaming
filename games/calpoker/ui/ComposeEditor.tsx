import { AmountInput } from '../../host/ui';
import type { ComposeEditorProps } from '../../host';

export function CalpokerComposeEditor({
  draft,
  disabled,
  maxPerHandMojos,
  onChange,
  onSubmit,
}: ComposeEditorProps<{ amount: bigint }>) {
  return (
    <AmountInput
      valueMojos={draft.amount}
      onChange={(amount) => onChange({ amount })}
      maxMojos={maxPerHandMojos}
      onUseMax={
        maxPerHandMojos != null && maxPerHandMojos > 0n
          ? () => onChange({ amount: maxPerHandMojos })
          : undefined
      }
      disabled={disabled}
      label="Per-player stake"
      exceedsLabel="Exceeds available reserve."
      onKeyDown={(event) => {
        if (event.key === 'Enter') onSubmit();
      }}
    />
  );
}
