import { useEffect, useId as useReactId, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Spinner as UiSpinner } from '@/components/ui/spinner';

/** Status messages (WCAG 4.1.3). Sonner toasts are polite live regions. */
export function useAnnounce() {
  return (message: string) => toast(message);
}

/** Kept for call sites that wrapped the app in it; the Toaster now does the job. */
export function AnnounceProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** Unique page titles (WCAG 2.4.2). */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · Roundabout` : 'Roundabout';
  }, [title]);
}

export function Spinner({ label }: { label: string }) {
  return <UiSpinner aria-label={label} />;
}

export function useId(prefix: string): string {
  // React's ids contain « » and :, which are awkward in selectors and idrefs.
  return `${prefix}-${useReactId().replace(/[^A-Za-z0-9_-]/g, '')}`;
}
