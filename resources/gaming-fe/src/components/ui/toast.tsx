import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';

const toastVariants = cva(
  'pointer-events-auto relative flex w-full items-start justify-between gap-3 overflow-hidden rounded-lg border px-4 py-3 text-sm shadow-lg transition-all',
  {
    variants: {
      variant: {
        default:     'bg-canvas-bg border-canvas-border text-canvas-text-contrast',
        destructive: 'bg-alert-solid border-alert-solid text-alert-on-alert',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface ToastProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof toastVariants> {
  title?: string;
  description?: string;
  onDismiss?: () => void;
}

export function Toast({ className, variant, title, description, onDismiss, ...props }: ToastProps) {
  return (
    <div className={cn(toastVariants({ variant }), className)} {...props}>
      <div className='flex-1 min-w-0'>
        {title && <p className='font-medium leading-tight'>{title}</p>}
        {description && (
          <p className={cn('text-xs mt-0.5', variant === 'destructive' ? 'opacity-85' : 'text-canvas-text')}>
            {description}
          </p>
        )}
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className='shrink-0 rounded opacity-70 hover:opacity-100 transition-opacity'
          aria-label='Dismiss'
        >
          <X className='h-4 w-4' />
        </button>
      )}
    </div>
  );
}
