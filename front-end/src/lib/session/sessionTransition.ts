import type { WasmNotification } from '../../types/ChiaGaming';

export type DurableNotificationKind =
  | 'accepted-group'
  | 'game-status'
  | 'settlement'
  | 'insufficient-balance'
  | 'abandoned'
  | null;

export function durableNotificationKind(notification: WasmNotification): DurableNotificationKind {
  if (notification.ProposalAcceptedGroup) return 'accepted-group';
  if (notification.GameSettled) return 'settlement';
  if (notification.GameStatus) return 'game-status';
  if (notification.InsufficientBalance) return 'insufficient-balance';
  if (notification.ChannelStatus?.session_disposition === 'Abandoned') return 'abandoned';
  return null;
}
