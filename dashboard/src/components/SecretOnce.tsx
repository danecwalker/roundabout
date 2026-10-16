import { TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import KeyField from './KeyField';

interface Props {
  secret: string;
  onDismiss?: () => void;
  label?: string;
  title?: string;
  hint?: string;
}

export default function SecretOnce({
  secret,
  onDismiss,
  label = 'Secret key',
  title = 'Copy your secret key now. It won’t be shown again.',
  hint = 'Store it on your server only (e.g. an environment variable). Never ship it to browsers.',
}: Props) {
  return (
    <Alert role="status">
      <TriangleAlert />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{hint}</p>
        <div className="mt-3 w-full">
          <KeyField label={label} value={secret} />
        </div>
        {onDismiss && (
          <Button type="button" size="sm" variant="outline" className="mt-3" onClick={onDismiss}>
            I’ve saved it
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
