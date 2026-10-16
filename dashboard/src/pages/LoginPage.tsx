import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useDocumentTitle } from '../a11y';
import AuthForm from '../components/AuthForm';
import Logo from '../components/Logo';
import { Card } from '@/components/ui/card';

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  useDocumentTitle('Sign in');
  // Assume open until the server says otherwise; it enforces the rule either way.
  const [signupEnabled, setSignupEnabled] = useState(true);
  useEffect(() => {
    api.config().then((c) => setSignupEnabled(c.signup_enabled)).catch(() => {});
  }, []);

  return (
    <main id="main" className="bg-muted flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center gap-2 self-center font-semibold">
          <Logo size={24} />
          Roundabout
        </div>
        <Card>
          <AuthForm
            signupEnabled={signupEnabled}
            onAuthed={() => {
              const from = (location.state as { from?: string } | null)?.from;
              navigate(from && from !== '/login' ? from : '/sites', { replace: true });
            }}
          />
        </Card>
        <p className="text-muted-foreground text-center text-sm">Privacy-friendly bot protection for your forms.</p>
      </div>
    </main>
  );
}
