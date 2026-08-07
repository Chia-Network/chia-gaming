export function SessionTransitionSurface() {
  return (
    <div className="relative w-full h-full min-h-0 flex flex-col bg-canvas-bg-subtle text-canvas-text pt-6">
      <div className="flex flex-col gap-2 px-4 pb-2 sm:px-6 md:px-8">
        <div className="relative overflow-hidden z-0">
          <div className="flex items-center justify-center py-20">
            <p className="text-canvas-text">Setting up channel…</p>
          </div>
        </div>
      </div>
    </div>
  );
}
