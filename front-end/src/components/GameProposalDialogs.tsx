import { useRef } from 'react';
import type { RegisteredGameProposalFormHandle } from '../lib/gamePackage';
import type { UseGameSessionResult } from '../hooks/useGameSession';
import {
  describeReceivedProposal,
  gameDisplayName,
  packageFor,
  REGISTERED_GAMES,
} from '../lib/gameRegistry';
import { Button } from './button';

export function ComposeProposalDialog({
  session,
  maxPerHandMojos,
}: {
  session: UseGameSessionResult;
  maxPerHandMojos: bigint | null;
}) {
  const compose = session.composeDraftState;
  const pkg = packageFor(compose.selectedGame);
  const formRef = useRef<RegisteredGameProposalFormHandle>(null);
  const canSubmit = !session.composeProposalSent && compose.gameTimeout > 0n;

  const submit = () => {
    if (!canSubmit) return;
    const result = formRef.current?.getProposal();
    if (!result?.ok) return;
    const senderIsPlayerA = compose.selectedGame === 'krunk' || !session.iStarted;
    const parameters = pkg.encodeProposalParameters(result.parameters);
    session.submitComposedProposal({
      gameType: compose.selectedGame,
      playerAContribution: senderIsPlayerA
        ? result.senderContribution
        : result.receiverContribution,
      playerBContribution: senderIsPlayerA
        ? result.receiverContribution
        : result.senderContribution,
      senderIsPlayerA,
      gameTimeout: compose.gameTimeout,
      parameters,
    });
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
        {pkg.renderHandProposalForm({
          ref: formRef,
          disabled: session.composeProposalSent,
          maxPerHandMojos,
          defaultContribution: session.perGameAmount,
          initialProposal:
            session.lastHandProposal?.gameType === compose.selectedGame
              ? session.lastHandProposal
              : null,
          onSubmit: submit,
        })}
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
        <p className="text-xs text-canvas-text">
          Game: {gameDisplayName(review.handProposal.gameType)}
        </p>
        <p className="text-xs text-canvas-text">{describeReceivedProposal(review.handProposal)}</p>
        <p className="text-xs text-canvas-text">
          Timeout: {String(review.handProposal.gameTimeout)} blocks
        </p>
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
