import type { WasmNotification } from '../../types/ChiaGaming';
import { gameSliceReducer, type GameSlice, type GameSliceAction } from './gameSlice';

export type DurableNotificationKind =
  | 'accepted-group'
  | 'game-status'
  | 'settlement'
  | 'insufficient-balance'
  | 'abandoned'
  | null;

export function durableNotificationKind(notification: WasmNotification): DurableNotificationKind {
  if (notification.ProposalAccepted) return 'accepted-group';
  if (notification.GameSettled) return 'settlement';
  if (notification.GameStatus) return 'game-status';
  if (notification.InsufficientBalance) return 'insufficient-balance';
  if (notification.ChannelStatus?.session_disposition === 'Abandoned') return 'abandoned';
  return null;
}

/**
 * One ordered host transition:
 * 1. derive and expose the generic slice synchronously;
 * 2. commit the game-owned opaque payload synchronously;
 * 3. schedule React's projection.
 */
export function commitSessionTransition(args: {
  current: GameSlice;
  action: GameSliceAction;
  exposeGeneric: (next: GameSlice) => void;
  commitGamePayload?: () => void;
  render: (action: GameSliceAction) => void;
}): GameSlice {
  const next = gameSliceReducer(args.current, args.action);
  args.exposeGeneric(next);
  args.commitGamePayload?.();
  args.render(args.action);
  return next;
}
