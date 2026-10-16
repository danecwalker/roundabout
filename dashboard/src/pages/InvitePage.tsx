import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { api, ApiError, ROLE_INFO, type InviteInfo, type User } from '../api';
import { Spinner, useAnnounce, useDocumentTitle } from '../a11y';
import { useAuth } from '../auth';
import AuthForm from '../components/AuthForm';
import Logo from '../components/Logo';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

export default function InvitePage() {
  const { token = '' } = useParams();
  const { user, refresh, setOrg } = useAuth();
  const navigate = useNavigate();
  const announce = useAnnounce();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  useDocumentTitle(info ? `Join ${info.org_name}` : 'Invitation');

  useEffect(() => {
    api
      .getInvite(token)
      .then(setInfo)
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) setMissing(true);
        else setError(e instanceof Error ? e.message : String(e));
      });
  }, [token]);

  async function accept(signedUp = false) {
    setAccepting(true);
    setError(null);
    try {
      let orgId: string | null = null;
      try {
        orgId = (await api.acceptInvite(token)).id;
      } catch (e) {
        // A signup that already consumed the invite makes accept fail; that's fine.
        if (!signedUp) throw e;
      }
      const me = await refresh();
      const joined = orgId ?? me?.orgs.find((o) => o.name === info?.org_name)?.id ?? null;
      if (joined) setOrg(joined);
      announce(`Joined ${info?.org_name ?? 'the organization'}`);
      navigate('/sites', { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setAccepting(false);
    }
  }

  const errorAlert = error && (
    <Alert variant="destructive" role="alert">
      <AlertCircle />
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );

  return (
    <main id="main" className="bg-muted flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center gap-2 self-center font-semibold">
          <Logo size={24} />
          Roundabout
        </div>
        {missing ? (
          <Card>
            <CardHeader>
              <CardTitle>
                <h1 className="text-xl">Invitation not found</h1>
              </CardTitle>
              <CardDescription>This invite link is invalid, expired or has already been used. Ask for a new one.</CardDescription>
            </CardHeader>
            <CardFooter>
              <Button asChild variant="outline">
                <Link to={user ? '/sites' : '/login'}>{user ? 'Go to your sites' : 'Sign in'}</Link>
              </Button>
            </CardFooter>
          </Card>
        ) : !info && !error ? (
          <div className="flex justify-center">
            <Spinner label="Loading invitation" />
          </div>
        ) : !info ? (
          errorAlert
        ) : (
          <Card>
            <CardContent className="grid gap-2">
              <p className="text-muted-foreground text-sm">You’ve been invited to join</p>
              <p className="text-lg font-semibold break-words">{info.org_name}</p>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>as</span>
                <Badge variant="secondary">{ROLE_INFO[info.role].label}</Badge>
              </div>
              <p className="text-muted-foreground text-sm">
                {ROLE_INFO[info.role].description}
                {info.invited_by && <> Invited by {info.invited_by}.</>} Expires {new Date(info.expires_at).toLocaleString()}.
              </p>
            </CardContent>
            <Separator />
            {user ? (
              <>
                <CardHeader>
                  <CardTitle>
                    <h1 className="text-xl">Accept invitation</h1>
                  </CardTitle>
                  <CardDescription>Signed in as {user.email}.</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4">
                  {errorAlert}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" onClick={() => accept()} disabled={accepting}>
                      {accepting ? 'Joining…' : `Join ${info.org_name}`}
                    </Button>
                    <Button asChild variant="ghost">
                      <Link to="/sites">Not now</Link>
                    </Button>
                  </div>
                </CardContent>
              </>
            ) : (
              <>
                {error && <div className="px-6">{errorAlert}</div>}
                <AuthForm
                  invite={token}
                  initialMode="signup"
                  headings={{ login: 'Sign in to accept', signup: 'Create an account to accept' }}
                  onAuthed={(_u: User, mode) => accept(mode === 'signup')}
                />
              </>
            )}
          </Card>
        )}
      </div>
    </main>
  );
}
