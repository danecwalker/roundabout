import { useState, type FormEvent } from 'react';
import { AlertCircle } from 'lucide-react';
import { useId } from '../a11y';
import { useAuth } from '../auth';
import type { User } from '../api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

interface Props {
  /** Passed to signup so invite-only servers accept the account. */
  invite?: string;
  initialMode?: 'login' | 'signup';
  /** When false (signups turned off on this server), only sign-in is offered. */
  signupEnabled?: boolean;
  onAuthed: (user: User, mode: 'login' | 'signup') => Promise<void> | void;
  /** Heading text, shown as the page's h1. */
  headings?: { login: string; signup: string };
  description?: string;
}

/** Renders CardHeader + CardContent; place it inside a Card. */
export default function AuthForm({ invite, initialMode = 'login', signupEnabled = true, onAuthed, headings, description }: Props) {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const ids = { email: useId('email'), password: useId('password'), emailErr: useId('email-err'), pwHint: useId('pw-hint'), pwErr: useId('pw-err') };
  const isLogin = mode === 'login';

  function validate() {
    const fe: typeof fieldErrors = {};
    if (!email.trim()) fe.email = 'Enter your email address.';
    else if (!/^[^\s@]+@[^\s@]+$/.test(email.trim())) fe.email = 'Enter a valid email address, like name@example.com.';
    if (!password) fe.password = 'Enter your password.';
    else if (!isLogin && password.length < 8) fe.password = 'Password must be at least 8 characters.';
    setFieldErrors(fe);
    return Object.keys(fe).length === 0;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!validate()) return;
    setBusy(true);
    try {
      const user = isLogin ? await login(email.trim(), password) : await signup(email.trim(), password, invite);
      await onAuthed(user, mode);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const h = headings ?? { login: 'Sign in', signup: 'Create an account' };
  return (
    <>
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl">{isLogin ? h.login : h.signup}</h1>
        </CardTitle>
        <CardDescription>
          {description ?? (isLogin ? 'Enter your email and password to continue.' : 'All fields are required.')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!fieldErrors.email}>
              <FieldLabel htmlFor={ids.email}>Email</FieldLabel>
              <Input
                id={ids.email}
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                aria-invalid={!!fieldErrors.email}
                aria-describedby={fieldErrors.email ? ids.emailErr : undefined}
              />
              {fieldErrors.email && <FieldError id={ids.emailErr}>{fieldErrors.email}</FieldError>}
            </Field>
            <Field data-invalid={!!fieldErrors.password}>
              <FieldLabel htmlFor={ids.password}>Password</FieldLabel>
              <Input
                id={ids.password}
                type="password"
                autoComplete={isLogin ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                aria-invalid={!!fieldErrors.password}
                aria-describedby={
                  [!isLogin ? ids.pwHint : '', fieldErrors.password ? ids.pwErr : ''].filter(Boolean).join(' ') || undefined
                }
              />
              {!isLogin && <FieldDescription id={ids.pwHint}>At least 8 characters.</FieldDescription>}
              {fieldErrors.password && <FieldError id={ids.pwErr}>{fieldErrors.password}</FieldError>}
            </Field>
            {(error || Object.keys(fieldErrors).length > 0) && (
              <Alert variant="destructive" role="alert">
                <AlertCircle />
                <AlertDescription>{error ?? 'Please fix the highlighted fields.'}</AlertDescription>
              </Alert>
            )}
            <Field>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? (isLogin ? 'Signing in…' : 'Creating account…') : isLogin ? 'Sign in' : 'Create account'}
              </Button>
              {!signupEnabled && isLogin ? (
                <FieldDescription className="text-center">
                  New accounts are turned off on this server. Ask an admin for an invite link.
                </FieldDescription>
              ) : (
              <FieldDescription className="text-center">
                {isLogin ? 'No account yet?' : 'Already have an account?'}{' '}
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0"
                  onClick={() => {
                    setMode(isLogin ? 'signup' : 'login');
                    setError(null);
                    setFieldErrors({});
                  }}
                >
                  {isLogin ? 'Create one' : 'Sign in'}
                </Button>
              </FieldDescription>
              )}
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </>
  );
}
