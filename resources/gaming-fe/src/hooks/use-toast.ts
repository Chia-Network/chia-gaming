import { useState, useEffect } from 'react';

export type ToastVariant = 'default' | 'destructive';

export interface Toast {
  id: string;
  title?: string;
  description?: string;
  variant?: ToastVariant;
}

type ToastInput = Omit<Toast, 'id'>;
type Subscriber = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
const subscribers: Subscriber[] = [];

function dispatch(next: Toast[]) {
  toasts = next;
  subscribers.forEach((s) => s(toasts));
}

export function dismiss(id: string) {
  dispatch(toasts.filter((t) => t.id !== id));
}

export function toast(input: ToastInput) {
  const id = Math.random().toString(36).slice(2);
  const newToast: Toast = { ...input, id };
  dispatch([newToast]);
}

export function useToast() {
  const [state, setState] = useState<Toast[]>(toasts);

  useEffect(() => {
    subscribers.push(setState);
    return () => {
      const i = subscribers.indexOf(setState);
      if (i !== -1) subscribers.splice(i, 1);
    };
  }, []);

  return { toasts: state };
}
