import type { HandProposalFormProps } from '../../host';
import { AmountInput } from './AmountInput';
import { isValidKrunkStake } from './handProposal';

export function HandProposalForm({
  draft,
  disabled,
  maxPerHandMojos,
  onChange,
  onSubmit,
}: HandProposalFormProps<{ amount: bigint }>) {
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
          Krunk stakes must be multiples of 100 mojos.
        </p>
      )}
    </>
  );
}
