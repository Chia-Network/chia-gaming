import { MutableRefObject } from 'react';

interface CardDividerProps {
  rightColumnRef: MutableRefObject<HTMLDivElement | null>;
}

export default function CardDivider({ rightColumnRef }: CardDividerProps) {
  return (
    <div
      onMouseDown={(e) => {
        const el = rightColumnRef.current as any;
        if (el && typeof el._startDrag === 'function') el._startDrag(e.clientY);
      }}
      onTouchStart={(e) => {
        const el = rightColumnRef.current as any;
        if (el && typeof el._startDrag === 'function')
          el._startDrag(e.touches[0].clientY);
      }}
      className='hidden md:block h-1 cursor-s-resize bg-transparent'
    />
  );
}
