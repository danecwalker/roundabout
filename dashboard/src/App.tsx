import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { Spinner, useDocumentTitle } from './a11y';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from './auth';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import SitesPage from './pages/SitesPage';
import NewSitePage from './pages/NewSitePage';
import SiteDetailPage from './pages/SiteDetailPage';
import ApiKeysPage from './pages/ApiKeysPage';
import TeamPage from './pages/TeamPage';
import InvitePage from './pages/InvitePage';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function BootError({ message }: { message: string }) {
  useDocumentTitle('Can’t reach the API');
  return (
    <main id="main" className="bg-muted flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl">Can’t reach the API</h1>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive" role="alert">
            <AlertCircle />
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        </CardContent>
        <CardFooter>
          <Button type="button" onClick={() => location.reload()}>
            Retry
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}

export default function App() {
  const { loading, bootError, user } = useAuth();

  if (loading) {
    return (
      <main id="main" className="flex min-h-svh items-center justify-center">
        <Spinner label="Loading Roundabout" />
      </main>
    );
  }
  if (bootError) return <BootError message={bootError} />;

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/sites" replace /> : <LoginPage />} />
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/sites" element={<SitesPage />} />
        <Route path="/sites/new" element={<NewSitePage />} />
        <Route path="/sites/:id" element={<SiteDetailPage />} />
        <Route path="/sites/:id/:tab" element={<SiteDetailPage />} />
        <Route path="/keys" element={<ApiKeysPage />} />
        <Route path="/team" element={<TeamPage />} />
      </Route>
      <Route path="*" element={<Navigate to={user ? '/sites' : '/login'} replace />} />
    </Routes>
  );
}
