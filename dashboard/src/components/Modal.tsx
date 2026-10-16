import { createContext, useCallback, useContext, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useId } from '../a11y';

interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}

export default function Modal({ open, title, description, onClose, children }: ModalProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

// --- Promise-based confirmation ----------------------------------------------

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** Require typing this exact text before confirming. */
  requireText?: string;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const [typed, setTyped] = useState('');
  const resolver = useRef<((v: boolean) => void) | undefined>(undefined);
  const inputId = useId('confirm-input');

  const confirm = useCallback<ConfirmFn>((o) => {
    resolver.current?.(false);
    setTyped('');
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const finish = (v: boolean) => {
    resolver.current?.(v);
    resolver.current = undefined;
    setOpts(null);
  };

  const ok = !opts?.requireText || typed === opts.requireText;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={!!opts} onOpenChange={(o) => !o && finish(false)}>
        <AlertDialogContent>
          <form
            className="grid gap-4"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (ok) finish(true);
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>{opts?.title}</AlertDialogTitle>
              {opts?.body && <AlertDialogDescription>{opts.body}</AlertDialogDescription>}
            </AlertDialogHeader>
            {opts?.requireText && (
              <div className="grid gap-2">
                <Label htmlFor={inputId}>
                  Type <span className="font-mono">{opts.requireText}</span> to confirm
                </Label>
                <Input id={inputId} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
              </div>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
              <AlertDialogAction
                type="submit"
                disabled={!ok}
                className={opts?.danger ? buttonVariants({ variant: 'destructive' }) : undefined}
                onClick={(e) => {
                  // Let the form submit handle it so Enter and click behave the same.
                  e.preventDefault();
                  if (ok) finish(true);
                }}
              >
                {opts?.confirmLabel}
              </AlertDialogAction>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}
