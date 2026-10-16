import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { useId } from '../a11y';
import CopyButton from './CopyButton';

export default function KeyField({ label, value, what }: { label: string; value: string; what?: string }) {
  const id = useId('key');
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <InputGroup>
        <InputGroupInput id={id} readOnly value={value} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <InputGroupAddon align="inline-end">
          <CopyButton value={value} what={what ?? label.toLowerCase()} variant="ghost" />
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
