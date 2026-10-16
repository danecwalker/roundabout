import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Globe, Plus, TriangleAlert } from 'lucide-react';
import { api, MODE_INFO, type Site } from '../api';
import { useDocumentTitle } from '../a11y';
import { useAuth } from '../auth';
import CopyButton from '../components/CopyButton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function domainSummary(s: Site): string {
  if (s.domains.includes('*')) return 'Any hostname';
  if (s.domains.length > 2) return `${s.domains.slice(0, 2).join(', ')} +${s.domains.length - 2}`;
  return s.domains.join(', ');
}

export default function SitesPage() {
  const { org, can } = useAuth();
  const [sites, setSites] = useState<Site[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useDocumentTitle('Sites');

  function load() {
    setError(null);
    setSites(null);
    api
      .listSites()
      .then(setSites)
      .catch((e: Error) => setError(e.message));
  }

  useEffect(load, []);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Sites</h1>
          <p className="text-muted-foreground text-sm">
            {sites && sites.length > 0 ? `${sites.length} ${sites.length === 1 ? 'site' : 'sites'} in ` : 'Sites in '}
            {org?.name}
          </p>
        </div>
        {can.editSites && (
          <Button asChild>
            <Link to="/sites/new">
              <Plus />
              New site
            </Link>
          </Button>
        )}
      </div>

      {error ? (
        <Alert variant="destructive" role="alert">
          <TriangleAlert />
          <AlertTitle>Couldn’t load sites</AlertTitle>
          <AlertDescription>
            <p>{error}</p>
            <Button variant="outline" size="sm" onClick={load}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : !sites ? (
        <Card className="gap-3 p-4" aria-busy="true" aria-label="Loading sites">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </Card>
      ) : sites.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Globe />
            </EmptyMedia>
            <EmptyTitle>No sites yet</EmptyTitle>
            <EmptyDescription>
              {can.editSites
                ? 'Create a site to get a sitekey and start protecting a form.'
                : 'Nothing here yet. Ask a member or admin to create a site.'}
            </EmptyDescription>
          </EmptyHeader>
          {can.editSites && (
            <EmptyContent>
              <Button asChild>
                <Link to="/sites/new">Create your first site</Link>
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <Card className="py-0">
          <Table>
            <TableCaption className="sr-only">Sites in {org?.name}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Site</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Sitekey</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Open</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sites.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="pl-4">
                    <div className="grid gap-0.5">
                      <Link to={`/sites/${s.id}`} className="font-medium hover:underline">
                        {s.name}
                      </Link>
                      <span className="text-muted-foreground text-sm">{domainSummary(s)}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="secondary">{MODE_INFO[s.mode].label}</Badge>
                      {s.clearance_enabled && <Badge variant="outline">Pre-clearance</Badge>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <code className="font-mono text-xs">{s.sitekey}</code>
                      <CopyButton value={s.sitekey} what={`sitekey for ${s.name}`} variant="ghost" />
                    </div>
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <Button asChild variant="ghost" size="icon" aria-label={`Open ${s.name}`}>
                      <Link to={`/sites/${s.id}`}>
                        <ChevronRight />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </>
  );
}
