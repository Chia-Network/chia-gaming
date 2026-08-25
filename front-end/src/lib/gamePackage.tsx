import { createElement, type ComponentType, type ReactElement } from 'react';
import type {
  ComposeDraftValue,
  GameHand,
  GameHandInitialization,
  GameHandState,
  GameMountRegistration,
  GameMountView,
  GamePackageRegistration,
  HandProposal,
  HandProposalBase,
  HandProposalDecodeContext,
  HandProposalFormProps,
  ProposalParameterValue,
} from '@games/host';

export type RegisteredGameHand = GameHand<unknown>;
export type GameComposeDrafts = Record<string, ComposeDraftValue>;

export interface RegisteredGamePackage {
  readonly gameType: string;
  readonly displayName: string;
  createHand(init: GameHandInitialization): RegisteredGameHand;
  restoreHand(savedState: unknown): RegisteredGameHand;
  describeHandProposal(handProposal: HandProposal): string;
  readonly draft: {
    default(perGameAmount: bigint): ComposeDraftValue;
    fromHandProposal(handProposal: HandProposal): ComposeDraftValue;
    update(current: ComposeDraftValue, update: Partial<ComposeDraftValue>): ComposeDraftValue;
    toHandProposal(draft: ComposeDraftValue, gameTimeout: bigint): HandProposal | null;
  };
  encodeProposalParameters(handProposal: HandProposal, iStarted: boolean): ProposalParameterValue;
  decodeHandProposal(
    base: HandProposalBase,
    parameterState: unknown,
    context: HandProposalDecodeContext,
  ): HandProposal | null;
  validateHandProposal(handProposal: HandProposal): boolean;
  handProposalsEqual(a: HandProposal, b: HandProposal): boolean;
  render(view: GameMountView<GameHandState<unknown>>): ReactElement;
  renderHandProposalForm(props: HandProposalFormProps<ComposeDraftValue>): ReactElement;
}

export function defineGamePackage<
  TState,
  THand extends GameHand<TState>,
  TDraft extends ComposeDraftValue,
  TParams,
>(
  feature: GamePackageRegistration<TState, THand, TDraft, TParams>,
  HandProposalForm: ComponentType<HandProposalFormProps<TDraft>>,
  mount: GameMountRegistration<THand>,
): RegisteredGamePackage {
  const requireState = (value: unknown): TState => value as TState;
  return {
    ...feature,
    createHand: (init) => feature.createHand(init) as RegisteredGameHand,
    restoreHand: (savedState) =>
      feature.restoreHand(requireState(savedState)) as RegisteredGameHand,
    draft: {
      default: feature.draft.default,
      fromHandProposal: feature.draft.fromHandProposal,
      update: (current, update) =>
        feature.draft.update(current as TDraft, update as Partial<TDraft>),
      toHandProposal: (draft, gameTimeout) =>
        feature.draft.toHandProposal(draft as TDraft, gameTimeout),
    },
    encodeProposalParameters: (handProposal, iStarted) =>
      feature.proposalParameters.encode(feature.toProposalParameters(handProposal, iStarted)),
    decodeHandProposal: (base, parameterState, context) => {
      const params = feature.proposalParameters.decode(parameterState);
      return params === null ? null : feature.decodeHandProposal(base, params, context);
    },
    render: (view) => mount.render(view as GameMountView<THand>),
    renderHandProposalForm: (props) =>
      createElement(HandProposalForm, {
        ...props,
        draft: props.draft as unknown as TDraft,
      }),
  };
}
