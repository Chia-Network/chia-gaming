import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './button';
import type { ConnectionField } from '../types/ChiaGaming';

interface SimulatorSetupModalProps {
  open: boolean;
  fields?: { balance?: ConnectionField };
  onConnect: (values: { balance?: number }) => void;
  connecting: boolean;
}

export function SimulatorSetupModal({ open, fields, onConnect, connecting }: SimulatorSetupModalProps) {
  const [balanceValue, setBalanceValue] = useState<number>(
    fields?.balance?.default ?? 1_000_000,
  );

  const panelRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const offsetRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (fields?.balance) {
      setBalanceValue(fields.balance.default);
    }
  }, [fields?.balance?.default]);

  useEffect(() => {
    if (open) {
      offsetRef.current = { x: 0, y: 0 };
      if (panelRef.current) panelRef.current.style.transform = 'translate(-50%, -50%)';
    }
  }, [open]);

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
    if (connecting) return;
    const values: { balance?: number } = {};
    if (fields?.balance) {
      values.balance = balanceValue;
    }
    onConnect(values);
  }, [connecting, fields, balanceValue, onConnect]);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex: 10, width: '22rem', maxWidth: 'calc(100% - 2rem)' }}
      className='border border-canvas-border bg-canvas-bg shadow-xl rounded-xl p-5 flex flex-col items-center gap-4'
    >
      <div
        onMouseDown={handleDragStart}
        style={{ cursor: 'grab' }}
        className='select-none w-full text-center'
      >
        <h2 className='text-lg font-semibold text-canvas-text-contrast leading-tight'>
          Simulator Setup
        </h2>
        <p className='text-sm text-canvas-text mt-0.5'>
          Configure the simulated blockchain connection
        </p>
      </div>

      {fields?.balance && (
        <div className='w-full'>
          <label className='block text-sm font-semibold mb-1 text-canvas-text-contrast text-center'>
            {fields.balance.label}
          </label>
          <input
            type='number'
            value={balanceValue}
            onChange={(e) => setBalanceValue(Number(e.target.value) || 0)}
            disabled={connecting}
            className='w-full text-sm font-mono rounded-md p-2 border border-canvas-border bg-canvas-bg-subtle text-canvas-text text-center'
          />
        </div>
      )}

      <Button
        variant='solid'
        onClick={handleConnect}
        disabled={connecting}
        isLoading={connecting}
        loadingText='Connecting&#x2026;'
      >
        Connect
      </Button>
    </div>
  );
}
