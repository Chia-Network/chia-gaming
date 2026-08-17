import type { UseGameSessionResult } from '../hooks/useGameSession';
import { isValidKrunkStake } from '../features/krunk/adapter';
import { gameDisplayName, REGISTERED_GAMES } from '../lib/gameRegistry';
import { composeDraftCanSubmit, composeDraftTerms } from '../lib/session/model';
import { formatMojos } from '../util';
import { AmountInput } from './AmountInput';
import { Button } from './button';

export function ComposeProposalDialog({
  session,
  maxPerHandMojos,
}: {
  session: UseGameSessionResult;
  maxPerHandMojos: bigint | null;
}) {
  const compose = session.composeDraftState;
  const isSpacepoker = compose.selectedGame === 'spacepoker';
  const isKrunk = compose.selectedGame === 'krunk';
  const spUnitSize = compose.spacepoker.unitSize;
  const spStackSize = compose.spacepoker.stackSize;
  const spBetSize = spUnitSize * spStackSize;
  const spMaxUnitSize =
    maxPerHandMojos != null && spStackSize > 0n ? maxPerHandMojos / spStackSize : null;
  const perHandAmount =
    compose.selectedGame === 'spacepoker' ? spBetSize : compose[compose.selectedGame].amount;
  const krunkStakeValid = !isKrunk || isValidKrunkStake(perHandAmount);
  const standardMaxMojos =
    isKrunk && maxPerHandMojos != null
      ? maxPerHandMojos - (maxPerHandMojos % 100n)
      : maxPerHandMojos;
  const canSubmit = composeDraftCanSubmit(compose, maxPerHandMojos);

  const submit = () => {
    if (!canSubmit) return;
    const terms = composeDraftTerms(compose);
    if (terms) session.submitComposedProposal(terms);
  };

  return (
    <div className="mx-auto w-full max-w-xl rounded-md border border-canvas-line bg-canvas-bg p-4 text-center">
      <div className="flex flex-col items-center gap-3">
        <p className="text-sm text-canvas-text-contrast">Propose terms for the next hand.</p>
        <div className="flex flex-wrap justify-center gap-2">
          {REGISTERED_GAMES.map(({ gameType, displayName }) => (
            <Button
              key={gameType}
              variant={compose.selectedGame === gameType ? 'solid' : 'outline'}
              color={compose.selectedGame === gameType ? 'primary' : 'neutral'}
              size="sm"
              disabled={session.composeProposalSent}
              onClick={() => session.setComposeGameType(gameType)}
            >
              {displayName}
            </Button>
          ))}
        </div>
        {isSpacepoker ? (
          <>
            <AmountInput
              valueMojos={spUnitSize}
              onChange={(unitSize) => session.setSpacepokerComposeDraft({ unitSize })}
              maxMojos={spMaxUnitSize}
              onUseMax={
                spMaxUnitSize != null && spMaxUnitSize > 0n
                  ? () => session.setSpacepokerComposeDraft({ unitSize: spMaxUnitSize })
                  : undefined
              }
              disabled={session.composeProposalSent}
              label="Unit size"
              exceedsLabel="Exceeds available reserve."
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canSubmit) submit();
              }}
            />
            <div className="flex w-full flex-col items-center gap-1">
              <label className="text-xs font-medium text-canvas-text">
                Stack size (units per player)
              </label>
              <input
                type="number"
                min={1}
                className="w-full rounded border border-canvas-line bg-canvas-bg px-2 py-1 text-center text-sm text-canvas-text-contrast focus:outline-none focus:ring-1 focus:ring-canvas-solid"
                value={spStackSize.toString()}
                disabled={session.composeProposalSent}
                onChange={(event) => {
                  const next = event.target.value.replace(/[^0-9]/g, '');
                  session.setSpacepokerComposeDraft({ stackSize: BigInt(next || '0') });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && canSubmit) submit();
                }}
              />
            </div>
            <div className="text-xs text-canvas-text">
              Per-player stake: {formatMojos(spBetSize)} · Total game size:{' '}
              {formatMojos(spBetSize * 2n)}
            </div>
          </>
        ) : (
          <AmountInput
            valueMojos={perHandAmount}
            onChange={isKrunk ? session.setKrunkComposeAmount : session.setCalpokerComposeAmount}
            maxMojos={standardMaxMojos}
            onUseMax={
              standardMaxMojos != null && standardMaxMojos > 0n
                ? () =>
                    isKrunk
                      ? session.setKrunkComposeAmount(standardMaxMojos)
                      : session.setCalpokerComposeAmount(standardMaxMojos)
                : undefined
            }
            disabled={session.composeProposalSent}
            label="Per-player stake"
            exceedsLabel="Exceeds available reserve."
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canSubmit) submit();
            }}
          />
        )}
        {isKrunk && perHandAmount > 0n && !krunkStakeValid && (
          <p className="text-xs text-alert-text">Krunk stakes must be multiples of 100 mojos.</p>
        )}
        <div className="flex w-full flex-col items-center gap-1">
          <label className="text-xs font-medium text-canvas-text">Timeout (blocks)</label>
          <input
            type="number"
            min={1}
            className="w-full rounded border border-canvas-line bg-canvas-bg px-2 py-1 text-center text-sm text-canvas-text-contrast focus:outline-none focus:ring-1 focus:ring-canvas-solid"
            value={compose.gameTimeout.toString()}
            disabled={session.composeProposalSent}
            onChange={(event) => {
              const next = event.target.value.replace(/[^0-9]/g, '');
              session.setComposeGameTimeout(BigInt(next || '0'));
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
          />
        </div>
        <Button
          variant="solid"
          color="primary"
          size="sm"
          className="self-center"
          disabled={!canSubmit}
          onClick={submit}
        >
          {session.composeProposalSent ? 'Proposal Sent' : 'Send Proposal'}
        </Button>
      </div>
    </div>
  );
}

export function ReviewProposalDialog({ session }: { session: UseGameSessionResult }) {
  const review = session.incomingProposalGroup;
  if (!review) return null;
  return (
    <div className="mx-auto w-full max-w-xl rounded-md border border-canvas-line bg-canvas-bg p-4">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-canvas-text-contrast">Do you want to accept this hand?</p>
        <p className="text-xs text-canvas-text">Game: {gameDisplayName(review.terms.gameType)}</p>
        <p className="text-xs text-canvas-text">
          Per-player stake: {formatMojos(review.terms.myContribution)}
        </p>
        <p className="text-xs text-canvas-text">
          Timeout: {String(review.terms.gameTimeout)} blocks
        </p>
        {review.terms.gameType === 'spacepoker' && (
          <p className="text-xs text-canvas-text">
            Unit size: {formatMojos(review.terms.unitSizeMojos)} · Stack:{' '}
            {String(review.terms.myContribution / review.terms.unitSizeMojos)} units
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="solid"
            color="primary"
            size="sm"
            onClick={session.acceptReviewedProposal}
          >
            Yes
          </Button>
          <Button variant="solid" size="sm" onClick={session.rejectReviewedProposal}>
            No
          </Button>
        </div>
      </div>
    </div>
  );
}
