import { createElement, type ComponentType, type ReactElement, type Ref } from 'react';
import type {
  GameHand,
  GameHandInitialization,
  GameHandState,
  GameMountRegistration,
  GameMountView,
  GamePackageRegistration,
  GameProposalFormHandle,
  HandProposal,
  HandProposalFormProps,
  ProposalParameterValue,
} from '@games/host';

export type RegisteredGameHand = GameHand<unknown>;
export type RegisteredGameProposalFormHandle = GameProposalFormHandle<unknown>;

export interface RegisteredGamePackage {
  readonly displayName: string;
  createHand(init: GameHandInitialization): RegisteredGameHand;
  restoreHand(savedState: unknown): RegisteredGameHand;
  describeHandProposal(handProposal: HandProposal): string;
  decodeProposalParameters(parameters: unknown): unknown | null;
  encodeProposalParameters(parameters: unknown): ProposalParameterValue;
  handProposalsEqual(a: HandProposal, b: HandProposal): boolean;
  render(view: GameMountView<GameHandState<unknown>>): ReactElement;
  renderHandProposalForm(props: HandProposalFormProps<unknown>): ReactElement;
}

export function defineGamePackage<TState, THand extends GameHand<TState>, TParams>(
  feature: GamePackageRegistration<TState, THand, TParams>,
  HandProposalForm: ComponentType<HandProposalFormProps<TParams>>,
  mount: GameMountRegistration<THand>,
): RegisteredGamePackage {
  return {
    ...feature,
    createHand: (init) => feature.createHand(init) as RegisteredGameHand,
    restoreHand: (savedState) => feature.restoreHand(savedState) as RegisteredGameHand,
    decodeProposalParameters: feature.proposalParameters.decode,
    encodeProposalParameters: (parameters) =>
      feature.proposalParameters.encode(parameters as TParams),
    render: (view) => mount.render(view as GameMountView<THand>),
    renderHandProposalForm: (props) =>
      createElement(HandProposalForm, {
        ...props,
        ref: props.ref as Ref<GameProposalFormHandle<TParams>>,
      }),
  };
}
