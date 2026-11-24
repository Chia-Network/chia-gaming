/**
 * Capture-phase Enter/Escape dismiss, so game window key handlers cannot steal
 * it. With `onConfirm`, Enter confirms instead and only Escape dismisses.
 */
export function bindNotificationOverlayDismissKeys(
  onDismiss: () => void,
  onConfirm?: () => void,
): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Enter' && onConfirm) onConfirm();
    else onDismiss();
  };
  window.addEventListener('keydown', onKeyDown, true);
  return () => window.removeEventListener('keydown', onKeyDown, true);
}
