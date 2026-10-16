import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

/** `what` names the copied value for assistive tech, e.g. "sitekey" → "Copy sitekey". */
export default function CopyButton({
  value,
  what,
  label = 'Copy',
  variant = 'outline',
}: {
  value: string;
  what: string;
  label?: string;
  variant?: 'outline' | 'ghost';
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`Copied ${what}`);
    } catch {
      toast.error(`Couldn’t copy ${what}. Select the text and copy it manually.`);
    }
  }

  return (
    <Button type="button" variant={variant} size="sm" onClick={copy} aria-label={`${copied ? 'Copied' : label} ${what}`}>
      {copied ? <Check /> : <Copy />}
      {copied ? 'Copied' : label}
    </Button>
  );
}
