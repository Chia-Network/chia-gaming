import { forwardRef, useImperativeHandle, useState } from 'react';
import type { GameProposalFormHandle, HandProposalFormProps } from '../../host';
import { AmountInput } from './AmountInput';
import { isValidKrunkStake } from './handProposal';

type KrunkParameters = Record<string, never>;

export const HandProposalForm = forwardRef<
  GameProposalFormHandle<KrunkParameters>,
  HandProposalFormProps<KrunkParameters>
>(function HandProposalForm(
  { disabled, maxPerHandMojos, defaultContribution, initialValues, onSubmit },
  ref,
) {
  const initialAmount = initialValues
    ? initialValues.senderContribution
    : defaultContribution > 0n
      ? defaultContribution
      : 100n;
  const [amount, setAmount] = useState(initialAmount);
  const [validationError, setValidationError] = useState<string | null>(null);
  const maxMojos =
    maxPerHandMojos != null ? maxPerHandMojos - (maxPerHandMojos % 100n) : maxPerHandMojos;
  useImperativeHandle(ref, () => ({
    getProposal: () => {
      const error = !isValidKrunkStake(amount)
        ? 'Krunk stakes must be positive multiples of 100 mojos.'
        : maxMojos !== null && amount > maxMojos
          ? 'Per-player stake exceeds the available reserve.'
          : null;
      setValidationError(error);
      return error
        ? { ok: false, error }
        : {
            ok: true,
            senderContribution: amount,
            receiverContribution: amount,
            parameters: {},
          };
    },
  }));
  return (
    <>
      <AmountInput
        valueMojos={amount}
        onChange={setAmount}
        maxMojos={maxMojos}
        onUseMax={
          maxMojos != null && maxMojos > 0n ? () => setAmount(maxMojos) : undefined
        }
        disabled={disabled}
        label="Per-player stake"
        exceedsLabel="Exceeds available reserve."
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSubmit();
        }}
      />
      {amount > 0n && !isValidKrunkStake(amount) && (
        <p className="text-xs text-alert-text">
          Krunk stakes must be multiples of 100 mojos.
        </p>
      )}
      {validationError && isValidKrunkStake(amount) && (
        <p className="text-xs text-alert-text">{validationError}</p>
      )}
    </>
  );
});
