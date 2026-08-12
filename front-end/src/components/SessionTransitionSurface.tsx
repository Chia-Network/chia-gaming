import { ACCEPT_SETTING_UP_COPY } from '../lib/session/acceptLifecycle';

export function SessionTransitionSurface() {
  return (
    <div className="w-full h-full min-h-0 flex items-center justify-center bg-canvas-bg-subtle text-canvas-text">
      <p className="text-canvas-text">{ACCEPT_SETTING_UP_COPY}</p>
    </div>
  );
}
