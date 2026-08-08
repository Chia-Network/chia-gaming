import { useEffect, useState } from 'react';
import type { UseGameSessionResult } from '../hooks/useGameSession';
import { isValidKrunkStake } from '../features/krunk/adapter';
import {
  GAME_REGISTRY,
  gameComposeDefaultAmount,
  gameDisplayName,
  isRegisteredGameType,
} from '../lib/gameRegistry';
import { DEFAULT_GAME_TIMEOUT_BLOCKS } from '../lib/session/model';
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
  const defaultSpacePokerStackSize = 10;
  const isSpacepoker = session.composeGameType === 'spacepoker';
  const isKrunk = session.composeGameType === 'krunk';
  const [spUnitSize, setSpUnitSize] = useState(() => {
    const remembered =
      session.lastHandTerms.gameType === 'spacepoker'
        ? session.lastHandTerms.unitSizeMojos
        : undefined;
    if (remembered && remembered > 0n) return remembered;
    const stake = session.composePerHandAmount;
    if (stake <= 0n) return 1n;
    return (stake + BigInt(defaultSpacePokerStackSize - 1)) / BigInt(defaultSpacePokerStackSize);
  });
  const [spStackSizeStr, setSpStackSizeStr] = useState(() => {
    const remembered =
      session.lastHandTerms.gameType === 'spacepoker'
        ? session.lastHandTerms.unitSizeMojos
        : undefined;
    return remembered && session.composePerHandAmount > 0n
      ? String(session.composePerHandAmount / remembered)
      : String(defaultSpacePokerStackSize);
  });
  const spStackSize = parseInt(spStackSizeStr) || 0;
  const [timeoutStr, setTimeoutStr] = useState(() =>
    String(
      session.composeGameTimeout > 0n ? session.composeGameTimeout : DEFAULT_GAME_TIMEOUT_BLOCKS,
    ),
  );
  useEffect(() => {
    setTimeoutStr(
      String(
        session.composeGameTimeout > 0n ? session.composeGameTimeout : DEFAULT_GAME_TIMEOUT_BLOCKS,
      ),
    );
  }, [session.composeGameTimeout]);
  const gameTimeout = BigInt(timeoutStr || '0');
  const timeoutValid = gameTimeout > 0n;
  const spBetSize = isSpacepoker ? spUnitSize * BigInt(spStackSize) : 0n;
  const spValid =
    isSpacepoker &&
    spUnitSize > 0n &&
    spStackSize > 0 &&
    (maxPerHandMojos == null || spBetSize <= maxPerHandMojos);
  const spMaxUnitSize =
    maxPerHandMojos != null && spStackSize > 0 ? maxPerHandMojos / BigInt(spStackSize) : null;
  const perHandAmount = isSpacepoker ? spBetSize : session.composePerHandAmount;
  const krunkStakeValid = !isKrunk || isValidKrunkStake(perHandAmount);
  const standardMaxMojos =
    isKrunk && maxPerHandMojos != null
      ? maxPerHandMojos - (maxPerHandMojos % 100n)
      : maxPerHandMojos;

  const submit = () => {
    if (perHandAmount <= 0n || !timeoutValid || !krunkStakeValid || session.composeProposalSent)
      return;
    const base = {
      myContribution: perHandAmount,
      theirContribution: perHandAmount,
      gameTimeout,
    };
    switch (session.composeGameType) {
      case 'spacepoker':
        session.submitComposedProposal({
          gameType: 'spacepoker',
          ...base,
          unitSizeMojos: spUnitSize,
        });
        break;
      case 'calpoker':
        session.submitComposedProposal({ gameType: 'calpoker', ...base });
        break;
      case 'krunk':
        session.submitComposedProposal({ gameType: 'krunk', ...base });
        break;
    }
  };
  const selectGameType = (gameType: string) => {
    if (!isRegisteredGameType(gameType)) return;
    session.setComposePerHandAmount(
      gameComposeDefaultAmount(gameType, session.composeGameType, session.composePerHandAmount),
    );
    session.setComposeGameType(gameType);
  };

  return (
    <div className="mx-auto w-full max-w-xl rounded-md border border-canvas-line bg-canvas-bg p-4 text-center">
      <div className="flex flex-col items-center gap-3">
        <p className="text-sm text-canvas-text-contrast">Propose terms for the next hand.</p>
        <div className="flex flex-wrap justify-center gap-2">
          {GAME_REGISTRY.map(({ gameType, displayName }) => (
            <Button
              key={gameType}
              variant={session.composeGameType === gameType ? 'solid' : 'outline'}
              color={session.composeGameType === gameType ? 'primary' : 'neutral'}
              size="sm"
              disabled={session.composeProposalSent}
              onClick={() => selectGameType(gameType)}
            >
              {displayName}
            </Button>
          ))}
        </div>
        {isSpacepoker ? (
          <>
            <AmountInput
              valueMojos={spUnitSize}
              onChange={setSpUnitSize}
              maxMojos={spMaxUnitSize}
              onUseMax={
                spMaxUnitSize != null && spMaxUnitSize > 0n
                  ? () => setSpUnitSize(spMaxUnitSize)
                  : undefined
              }
              disabled={session.composeProposalSent}
              label="Unit size"
              exceedsLabel="Exceeds available reserve."
              onKeyDown={(event) => {
                if (event.key === 'Enter' && spValid && timeoutValid) submit();
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
                value={spStackSizeStr}
                disabled={session.composeProposalSent}
                onChange={(event) => setSpStackSizeStr(event.target.value.replace(/[^0-9]/g, ''))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && spValid && timeoutValid) submit();
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
            valueMojos={session.composePerHandAmount}
            onChange={session.setComposePerHandAmount}
            maxMojos={standardMaxMojos}
            onUseMax={
              standardMaxMojos != null && standardMaxMojos > 0n
                ? () => session.setComposePerHandAmount(standardMaxMojos)
                : undefined
            }
            disabled={session.composeProposalSent}
            label="Per-player stake"
            exceedsLabel="Exceeds available reserve."
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                session.composePerHandAmount > 0n &&
                timeoutValid &&
                krunkStakeValid
              )
                submit();
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
            value={timeoutStr}
            disabled={session.composeProposalSent}
            onChange={(event) => {
              const next = event.target.value.replace(/[^0-9]/g, '');
              setTimeoutStr(next);
              if (next) session.setComposeGameTimeout(BigInt(next));
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
          disabled={
            session.composeProposalSent ||
            perHandAmount <= 0n ||
            !timeoutValid ||
            !krunkStakeValid ||
            (isSpacepoker && !spValid)
          }
          onClick={submit}
        >
          {session.composeProposalSent ? 'Proposal Sent' : 'Send Proposal'}
        </Button>
      </div>
    </div>
  );
}

export function ReviewProposalDialog({ session }: { session: UseGameSessionResult }) {
  const review = session.reviewPeerProposal;
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
