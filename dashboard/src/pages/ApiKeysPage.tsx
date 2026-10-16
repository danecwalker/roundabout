import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type ApiKey } from '../api';
import { Spinner, useAnnounce, useDocumentTitle, useId } from '../a11y';
import { useAuth } from '../auth';
import CodeBlock from '../components/CodeBlock';
import { useConfirm } from '../components/Modal';
import SecretOnce from '../components/SecretOnce';
import { AlertCircle, KeyRound, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function fmt(ts: string | null) {
  return ts ? new Date(ts).toLocaleString() : 'Never';
}

export default function ApiKeysPage() {
  const { org, can } = useAuth();
  const confirm = useConfirm();
  const announce = useAnnounce();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const nameId = useId('key-name');
  useDocumentTitle('API keys');

  const load = useCallback(() => {
    if (!can.manageKeys) return;
    setError(null);
    api
      .listKeys()
      .then(setKeys)
      .catch((e: Error) => setError(e.message));
  }, [can.manageKeys]);

  useEffect(load, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setNameError('Enter a name so you can tell keys apart.');
      return;
    }
    setNameError(null);
    setCreating(true);
    setCreateError(null);
    try {
      const { key, token } = await api.createKey(name.trim());
      setKeys((k) => [key, ...(k ?? [])]);
      setNewToken(token);
      setName('');
      announce(`API key ${key.name} created. Copy it now.`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function del(key: ApiKey) {
    const ok = await confirm({
      title: `Delete API key “${key.name}”?`,
      body: 'Anything using it (scripts, CI, Terraform) stops working immediately.',
      confirmLabel: 'Delete key',
      danger: true,
    });
    if (!ok) return;
    setDeleting(key.id);
    setError(null);
    try {
      await api.deleteKey(key.id);
      setKeys((k) => (k ?? []).filter((x) => x.id !== key.id));
      announce(`Deleted API key ${key.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(null);
    }
  }

  const origin = window.location.origin;
  const curl = `curl ${origin}/api/sites \\
  -H "Authorization: Bearer $ROUNDABOUT_API_KEY"`;
  const hcl = `provider "roundabout" {
  endpoint = "${origin}"
  api_key  = var.roundabout_api_key
}

resource "roundabout_site" "shop" {
  name       = "Shop"
  domains    = ["shop.example.com"]
  mode       = "managed"
  difficulty = 16
}

output "sitekey" { value = roundabout_site.shop.sitekey }`;

  const errorAlert = (msg: string, retry?: () => void) => (
    <Alert variant="destructive" role="alert">
      <AlertCircle />
      <AlertDescription>
        <p>
          {msg}{' '}
          {retry && (
            <Button type="button" variant="link" className="h-auto p-0" onClick={retry}>
              Retry
            </Button>
          )}
        </p>
      </AlertDescription>
    </Alert>
  );

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
          <p className="text-muted-foreground text-sm">
            Keys belong to <strong>{org?.name}</strong> and can manage its sites from scripts, CI or Terraform. They
            can’t manage other API keys.
          </p>
        </div>
      </div>

      <div className="grid gap-6">
        {!can.manageKeys ? (
          <Alert>
            <ShieldAlert />
            <AlertTitle>Admins only</AlertTitle>
            <AlertDescription>Ask an admin or owner of {org?.name} to create an API key for you.</AlertDescription>
          </Alert>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>Create a key</h2>
                </CardTitle>
                <CardDescription>Give it a name so you can tell keys apart later.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <form onSubmit={create} noValidate className="flex flex-col gap-3 sm:flex-row sm:items-start">
                  <Field data-invalid={!!nameError} className="flex-1">
                    <FieldLabel htmlFor={nameId} className="sr-only">
                      Key name
                    </FieldLabel>
                    <Input
                      id={nameId}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. terraform-prod"
                      maxLength={100}
                      required
                      aria-invalid={!!nameError}
                      aria-describedby={nameError ? `${nameId}-err` : undefined}
                    />
                    {nameError && <FieldError id={`${nameId}-err`}>{nameError}</FieldError>}
                  </Field>
                  <Button type="submit" disabled={creating}>
                    <Plus />
                    {creating ? 'Creating…' : 'Create key'}
                  </Button>
                </form>
                {createError && errorAlert(createError)}
                {newToken && (
                  <SecretOnce
                    secret={newToken}
                    label="API key"
                    title="Copy your API key now. It won’t be shown again."
                    hint="Treat it like a password. Store it in your CI secrets or a Terraform variable."
                    onDismiss={() => setNewToken(null)}
                  />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>Keys in {org?.name}</h2>
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                {error && errorAlert(error, load)}
                {!keys && !error && <Spinner label="Loading keys" />}
                {keys && keys.length === 0 && (
                  <Empty className="border">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <KeyRound />
                      </EmptyMedia>
                      <EmptyTitle>No API keys yet</EmptyTitle>
                      <EmptyDescription>Create one above to automate site management.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
                {keys && keys.length > 0 && (
                  <Table>
                    <TableCaption className="sr-only">API keys in {org?.name}</TableCaption>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Key</TableHead>
                        <TableHead>Created by</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead>Last used</TableHead>
                        <TableHead>
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {keys.map((k) => (
                        <TableRow key={k.id}>
                          <TableCell className="font-medium">{k.name}</TableCell>
                          <TableCell className="font-mono text-xs">{k.prefix}…</TableCell>
                          <TableCell>{k.created_by ?? <span className="text-muted-foreground">Unknown</span>}</TableCell>
                          <TableCell className="text-muted-foreground">{fmt(k.created_at)}</TableCell>
                          <TableCell className="text-muted-foreground">{fmt(k.last_used_at)}</TableCell>
                          <TableCell className="text-right">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="text-destructive"
                              onClick={() => del(k)}
                              disabled={deleting === k.id}
                              aria-label={`Delete API key ${k.name}`}
                            >
                              <Trash2 />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </>
        )}

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Usage</h2>
            </CardTitle>
            <CardDescription>
              Send the key as <code className="font-mono">Authorization: Bearer rbk_…</code> to the same endpoints the
              dashboard uses.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid items-start gap-4 lg:grid-cols-2">
            <CodeBlock label="curl" code={curl} />
            <CodeBlock label="Terraform" code={hcl} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
