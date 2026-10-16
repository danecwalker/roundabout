import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Site } from '../api';
import { useAnnounce, useDocumentTitle } from '../a11y';
import { useAuth } from '../auth';
import KeyField from '../components/KeyField';
import SecretOnce from '../components/SecretOnce';
import SiteForm from '../components/SiteForm';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter } from '@/components/ui/card';

function Crumbs({ current }: { current: string }) {
  return (
    <Breadcrumb className="mb-2">
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link to="/sites">Sites</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>{current}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

export default function NewSitePage() {
  const { can } = useAuth();
  const announce = useAnnounce();
  const [created, setCreated] = useState<{ site: Site; secret: string } | null>(null);
  useDocumentTitle(created ? `${created.site.name} created` : 'New site');

  if (created) {
    return (
      <>
        <Crumbs current={created.site.name} />
        <div className="mb-6 grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{created.site.name} is ready</h1>
          <p className="text-muted-foreground text-sm">
            Embed the sitekey in your pages and use the secret to verify tokens on your server.
          </p>
        </div>
        <Card>
          <CardContent className="grid gap-6">
            <KeyField label="Sitekey (public)" value={created.site.sitekey} what="sitekey" />
            <SecretOnce secret={created.secret} />
          </CardContent>
          <CardFooter>
            <Button asChild>
              <Link to={`/sites/${created.site.id}/setup`}>Continue to setup</Link>
            </Button>
          </CardFooter>
        </Card>
      </>
    );
  }

  return (
    <>
      <Crumbs current="New site" />
      <div className="mb-6 grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">New site</h1>
        <p className="text-muted-foreground text-sm">Each site gets its own sitekey, secret and settings.</p>
      </div>
      <Card>
        <CardContent>
          {can.editSites ? (
            <SiteForm
              submitLabel="Create site"
              busyLabel="Creating…"
              onSubmit={async (input) => {
                const r = await api.createSite(input);
                setCreated(r);
                announce(`Site ${r.site.name} created. Copy the secret key now.`);
              }}
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              You have view-only access in this organization, so you can’t create sites.
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
