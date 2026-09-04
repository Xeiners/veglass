import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';

import { cn } from '@/lib/cn';
import { useEditor, type ToastTone } from '@/store/editorStore';

const TONES: Record<ToastTone, { icon: typeof Info; className: string }> = {
  info: { icon: Info, className: 'text-white/60' },
  success: { icon: CheckCircle2, className: 'text-accent-300' },
  error: { icon: TriangleAlert, className: 'text-red-400' },
};

export function Toaster() {
  const toasts = useEditor((state) => state.toasts);
  const dismiss = useEditor((state) => state.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[60] flex w-full max-w-md -translate-x-1/2 flex-col items-center gap-2 px-6">
      {toasts.map((toast) => {
        const { icon: Icon, className } = TONES[toast.tone];
        return (
          <div
            key={toast.id}
            role="status"
            className={cn(
              'pointer-events-auto flex w-full animate-slide-up items-center gap-3 rounded-xl',
              'border border-white/[0.09] bg-ink-800/92 px-3.5 py-3 shadow-lift backdrop-blur-2xl',
            )}
          >
            <Icon size={15} strokeWidth={2} className={cn('shrink-0', className)} />
            <p className="min-w-0 flex-1 text-[13px] leading-snug text-white/85">{toast.message}</p>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label="Fermer la notification"
              className="-mr-1 grid h-6 w-6 shrink-0 place-items-center rounded-md text-white/30 transition-colors hover:bg-white/[0.07] hover:text-white/70"
            >
              <X size={13} strokeWidth={2.2} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
