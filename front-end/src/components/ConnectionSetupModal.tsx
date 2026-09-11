import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './button';
import type { ConnectionField, ConnectionFieldValues } from '../types/ChiaGaming';

interface ConnectionSetupModalProps {
  open: boolean;
  title?: string;
  description?: string;
  fields?: Record<string, ConnectionField>;
  onConnect: (values: ConnectionFieldValues) => void;
  onCancel?: () => void;
  connecting: boolean;
  error?: string | null;
}

export function ConnectionSetupModal({
  open,
  title,
  description,
  fields,
  onConnect,
  onCancel,
  connecting,
  error,
}: ConnectionSetupModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null,
  );
  const offsetRef = useRef({ x: 0, y: 0 });

  const fieldEntries = useMemo(() => (fields ? Object.entries(fields) : []), [fields]);
  const [inputs, setInputs] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    const initial: Record<string, string> = {};
    for (const [key, field] of Object.entries(fields ?? {})) {
      initial[key] = field.type === 'bigint' ? field.default.toString() : field.default;
    }
    setInputs(initial);
    offsetRef.current = { x: 0, y: 0 };
    if (panelRef.current) panelRef.current.style.transform = 'translate(-50%, -50%)';
    // Re-initialize whenever the modal opens or the field set changes.
  }, [open, fields]);

  const clampToContainer = useCallback((x: number, y: number) => {
    const panel = panelRef.current;
    if (!panel) return { x, y };
    const container = panel.offsetParent as HTMLElement | null;
    if (!container) return { x, y };

    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    const cw = container.clientWidth;
    const ch = container.clientHeight;

    const minX = pw / 2 - cw / 2;
    const maxX = cw / 2 - pw / 2;
    const minY = ph / 2 - ch / 2;
    const maxY = ch / 2 - ph / 2;

    return {
      x: minX < maxX ? Math.max(minX, Math.min(maxX, x)) : 0,
      y: minY < maxY ? Math.max(minY, Math.min(maxY, y)) : 0,
    };
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragState.current || !panelRef.current) return;
      e.preventDefault();
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
      const rawX = dragState.current.origX + (e.clientX - dragState.current.startX);
      const rawY = dragState.current.origY + (e.clientY - dragState.current.startY);
      const { x, y } = clampToContainer(rawX, rawY);
      offsetRef.current = { x, y };
      panelRef.current.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
    };
    const onUp = () => {
      dragState.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [clampToContainer]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: offsetRef.current.x,
      origY: offsetRef.current.y,
    };
  }, []);

  const handleConnect = useCallback(() => {
    const values: ConnectionFieldValues = {};
    for (const [key, field] of fieldEntries) {
      const raw = inputs[key] ?? '';
      if (field.type === 'bigint') {
        try {
          values[key] = BigInt(raw.trim() === '' ? '0' : raw.trim());
        } catch {
          values[key] = field.default;
        }
      } else {
        values[key] = raw;
      }
    }
    onConnect(values);
  }, [fieldEntries, inputs, onConnect]);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 10,
        width: '22rem',
        maxWidth: 'calc(100% - 2rem)',
      }}
      className="border border-canvas-border bg-canvas-bg shadow-xl rounded-xl p-5 flex flex-col items-stretch gap-4"
    >
      <div
        onMouseDown={handleDragStart}
        style={{ cursor: 'grab' }}
        className="select-none w-full text-center"
      >
        <h2 className="text-lg font-semibold text-canvas-text-contrast leading-tight">
          {title ?? 'Connect'}
        </h2>
        {description ? <p className="text-sm text-canvas-text mt-0.5">{description}</p> : null}
      </div>

      {fieldEntries.length > 0 ? (
        <div className="flex flex-col gap-3 w-full">
          {fieldEntries.map(([key, field]) => (
            <label key={key} className="flex flex-col gap-1 text-sm text-canvas-text">
              <span>{field.label}</span>
              <input
                type="text"
                inputMode={field.type === 'bigint' ? 'numeric' : 'text'}
                value={inputs[key] ?? ''}
                onChange={(e) => setInputs((prev) => ({ ...prev, [key]: e.target.value }))}
                disabled={connecting}
                className="px-3 py-2 rounded-md bg-canvas-bg-subtle text-canvas-text border border-canvas-border outline-none"
              />
            </label>
          ))}
        </div>
      ) : null}

      {error ? <p className="text-sm text-alert-text break-words">{error}</p> : null}

      <div className="flex items-center justify-center gap-2">
        {onCancel ? (
          <Button variant="outline" onClick={onCancel} disabled={connecting}>
            Cancel
          </Button>
        ) : null}
        <Button
          variant="solid"
          onClick={handleConnect}
          disabled={connecting}
          isLoading={connecting}
          loadingText="Connecting&#x2026;"
        >
          Connect
        </Button>
      </div>
    </div>
  );
}
