import { ACCEPT_SETTING_UP_COPY } from '../lib/session/acceptLifecycle';
import { Setup2048 } from './Setup2048';

export function SessionTransitionSurface() {
  return (
    <div className="w-full h-full min-h-0 overflow-y-auto bg-canvas-bg-subtle text-canvas-text p-4">
      <div className="min-h-full flex flex-col items-center justify-center gap-4">
        <p className="text-sm text-canvas-text">{ACCEPT_SETTING_UP_COPY}</p>
        <Setup2048 />
      </div>
    </div>
  );
}
