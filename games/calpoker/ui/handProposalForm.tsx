import { forwardRef, useImperativeHandle, useState } from 'react';
import type { GameProposalFormHandle, HandProposalFormProps } from '../../host';
import { AmountInput } from './AmountInput';

type CalpokerParameters = Record<string, never>;

export const HandProposalForm = forwardRef<
  GameProposalFormHandle<CalpokerParameters>,
  HandProposalFormProps<CalpokerParameters>
>(function HandProposalForm(
  { disabled, maxPerHandMojos, defaultContribution, initialValues, onSubmit },
  ref,
) {
  const initialAmount = initialValues?.senderContribution ?? defaultContribution;
  const [amount, setAmount] = useState(initialAmount);
  useImperativeHandle(ref, () => ({
    getProposal: () =>
      amount > 0n && (maxPerHandMojos === null || amount <= maxPerHandMojos)
        ? {
            ok: true,
            senderContribution: amount,
            receiverContribution: amount,
            parameters: {},
          }
        : { ok: false, error: 'Enter a positive stake within the available reserve.' },
  }));
  return (
    <AmountInput
      valueMojos={amount}
      onChange={setAmount}
      maxMojos={maxPerHandMojos}
      onUseMax={
        maxPerHandMojos != null && maxPerHandMojos > 0n
          ? () => setAmount(maxPerHandMojos)
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
});
