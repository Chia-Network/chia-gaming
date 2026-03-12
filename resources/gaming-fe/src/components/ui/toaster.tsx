import { useToast, dismiss } from '../../hooks/use-toast';
import { Toast } from './toast';

export function Toaster() {
  const { toasts } = useToast();

  return (
    <div className='fixed top-10 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]'>
      {toasts.map((t) => (
        <Toast
          key={t.id}
          variant={t.variant}
          title={t.title}
          description={t.description}
          onDismiss={() => dismiss(t.id)}
        />
      ))}
    </div>
  );
}
