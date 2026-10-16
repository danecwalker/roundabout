import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ROLE_INFO, type Invite, type Member, type Role } from '../api';
import { Spinner, useAnnounce, useDocumentTitle, useId } from '../a11y';
import { useAuth } from '../auth';
import KeyField from '../components/KeyField';
import { useConfirm } from '../components/Modal';
import { AlertCircle, ChevronDown, ChevronRight, Link2, Trash2, UserMinus } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function ErrorAlert({ message }: { message: string }) {
  return (
    <Alert variant="destructive" role="alert">
      <AlertCircle />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer'];

function fmtDate(ts: string) {
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function errText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export default function TeamPage() {
  const { user, org, can, refresh } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const announce = useAnnounce();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyMember, setBusyMember] = useState<string | null>(null);
  useDocumentTitle('Team');

  const orgId = org?.id ?? '';

  const load = useCallback(() => {
    if (!orgId) return;
    setError(null);
    api
      .listMembers(orgId)
      .then(setMembers)
      .catch((e) => setError(errText(e)));
    if (can.manageTeam) {
      api
        .listInvites(orgId)
        .then(setInvites)
        .catch((e) => setError(errText(e)));
    }
  }, [orgId, can.manageTeam]);

  useEffect(load, [load]);

  if (!org) return null;

  /** Admins can't touch owners or grant ownership; owners can do anything. */
  function canEdit(m: Member) {
    if (m.user_id === user?.id) return false;
    if (can.owner) return true;
    return can.manageTeam && m.role !== 'owner';
  }

  async function changeRole(m: Member, role: Role) {
    if (role === m.role) return;
    setBusyMember(m.user_id);
    setError(null);
    try {
      const updated = await api.setMemberRole(orgId, m.user_id, role);
      setMembers((ms) => (ms ?? []).map((x) => (x.user_id === m.user_id ? { ...x, ...updated } : x)));
      announce(`${m.email} is now ${ROLE_INFO[role].label}`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusyMember(null);
    }
  }

  async function remove(m: Member) {
    const self = m.user_id === user?.id;
    const ok = await confirm(
      self
        ? {
            title: `Leave ${org!.name}?`,
            body: 'You’ll lose access to its sites and API keys until someone invites you again.',
            confirmLabel: 'Leave organization',
            danger: true,
          }
        : {
            title: `Remove ${m.email}?`,
            body: `They’ll lose access to ${org!.name} immediately.`,
            confirmLabel: 'Remove member',
            danger: true,
          },
    );
    if (!ok) return;
    setBusyMember(m.user_id);
    setError(null);
    try {
      await api.removeMember(orgId, m.user_id);
      if (self) {
        announce(`Left ${org!.name}`);
        await refresh();
        navigate('/sites');
        return;
      }
      setMembers((ms) => (ms ?? []).filter((x) => x.user_id !== m.user_id));
      announce(`Removed ${m.email}`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusyMember(null);
    }
  }

  async function revoke(inv: Invite) {
    const ok = await confirm({
      title: 'Revoke this invite?',
      body: 'The link stops working immediately.',
      confirmLabel: 'Revoke invite',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.revokeInvite(orgId, inv.id);
      setInvites((is) => (is ?? []).filter((x) => x.id !== inv.id));
      announce('Invite revoked');
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
          <p className="text-muted-foreground text-sm">
            People in <strong>{org.name}</strong>. Your role: <strong>{ROLE_INFO[org.role].label}</strong>.
          </p>
        </div>
      </div>

      <div className="grid gap-6">
        {error && <ErrorAlert message={error} />}

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Organization</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <RenameOrg key={org.id} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Members</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            {!members ? (
              <Spinner label="Loading members" />
            ) : (
              <Table>
                <TableCaption className="sr-only">Members of {org.name}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Joined</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map((m) => {
                    const self = m.user_id === user?.id;
                    const editable = canEdit(m);
                    const options = ROLES.filter((r) => can.owner || r !== 'owner');
                    return (
                      <TableRow key={m.user_id}>
                        <TableCell className="font-medium break-all whitespace-normal">
                          {m.email}
                          {self && <span className="text-muted-foreground font-normal"> (you)</span>}
                        </TableCell>
                        <TableCell>
                          {editable ? (
                            <Select
                              value={m.role}
                              disabled={busyMember === m.user_id}
                              onValueChange={(v) => changeRole(m, v as Role)}
                            >
                              <SelectTrigger size="sm" className="w-32" aria-label={`Role for ${m.email}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {options.map((r) => (
                                  <SelectItem key={r} value={r}>
                                    {ROLE_INFO[r].label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Badge variant="secondary">{ROLE_INFO[m.role].label}</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{fmtDate(m.joined_at)}</TableCell>
                        <TableCell className="text-right">
                          {(self || editable) && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={busyMember === m.user_id}
                              onClick={() => remove(m)}
                              aria-label={self ? `Leave ${org.name}` : `Remove ${m.email}`}
                            >
                              <UserMinus />
                              {self ? 'Leave' : 'Remove'}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
            <RolesHelp />
          </CardContent>
        </Card>

        {can.manageTeam && (
          <>
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>Invite someone</h2>
                </CardTitle>
                <CardDescription>
                  Roundabout is self-hosted, so it doesn’t send email. Create a link and share it yourself. Links expire
                  after 7 days and work once.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <InviteForm onCreated={(inv) => setInvites((is) => [inv, ...(is ?? [])])} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>Pending invites</h2>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!invites ? (
                  <Spinner label="Loading invites" />
                ) : invites.length === 0 ? (
                  <Empty className="border">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Link2 />
                      </EmptyMedia>
                      <EmptyTitle>No pending invites</EmptyTitle>
                      <EmptyDescription>Invite links you create show up here until they’re used or expire.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <Table>
                    <TableCaption className="sr-only">Pending invites</TableCaption>
                    <TableHeader>
                      <TableRow>
                        <TableHead>For</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Invited by</TableHead>
                        <TableHead>Expires</TableHead>
                        <TableHead>
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {invites.map((inv) => (
                        <TableRow key={inv.id}>
                          <TableCell className="break-all whitespace-normal">
                            {inv.email ?? <span className="text-muted-foreground">Anyone with the link</span>}
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary">{ROLE_INFO[inv.role].label}</Badge>
                          </TableCell>
                          <TableCell>{inv.invited_by ?? <span className="text-muted-foreground">Unknown</span>}</TableCell>
                          <TableCell className="text-muted-foreground">{fmtDate(inv.expires_at)}</TableCell>
                          <TableCell className="text-right">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="text-destructive"
                              onClick={() => revoke(inv)}
                              aria-label={`Revoke invite${inv.email ? ` for ${inv.email}` : ''}`}
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

        {can.owner && (
          <Card className="border-destructive">
            <CardHeader>
              <CardTitle>
                <h2>Danger zone</h2>
              </CardTitle>
              <CardDescription>Deleting an organization removes everything in it. This can’t be undone.</CardDescription>
            </CardHeader>
            <CardContent>
              <DeleteOrg />
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}

function RolesHelp() {
  const [open, setOpen] = useState(false);
  const id = useId('roles-help');
  return (
    <div className="grid gap-2">
      <Button
        type="button"
        variant="link"
        className="h-auto justify-self-start p-0"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown /> : <ChevronRight />}
        What can each role do?
      </Button>
      {open && (
        <dl id={id} className="grid gap-3 text-sm">
          {ROLES.map((r) => (
            <div key={r}>
              <dt className="font-medium">{ROLE_INFO[r].label}</dt>
              <dd className="text-muted-foreground">{ROLE_INFO[r].description}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function RenameOrg() {
  const { org, can, refresh } = useAuth();
  const announce = useAnnounce();
  const [name, setName] = useState(org?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId('org-rename');

  if (!org) return null;
  if (!can.manageTeam) {
    return (
      <p className="text-sm">
        Name: <strong>{org.name}</strong>
      </p>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError('Enter a name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.renameOrg(org!.id, name.trim());
      await refresh();
      announce('Organization renamed');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <Field data-invalid={!!error} className="flex-1">
        <FieldLabel htmlFor={id}>Name</FieldLabel>
        <Input
          id={id}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          required
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-err` : undefined}
        />
        {error && (
          <FieldError id={`${id}-err`} role="alert">
            {error}
          </FieldError>
        )}
      </Field>
      <Button type="submit" variant="outline" disabled={busy || name.trim() === org.name}>
        {busy ? 'Saving…' : 'Rename'}
      </Button>
    </form>
  );
}

function InviteForm({ onCreated }: { onCreated: (inv: Invite) => void }) {
  const { org, can } = useAuth();
  const announce = useAnnounce();
  const [role, setRole] = useState<Role>('member');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const roleId = useId('invite-role');
  const emailId = useId('invite-email');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!org) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.createInvite(org.id, role, email.trim() || undefined);
      setUrl(r.url);
      onCreated(r.invite);
      setEmail('');
      announce('Invite link created. Copy it and share it with your teammate.');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const roles = ROLES.filter((r) => can.owner || r !== 'owner');
  return (
    <div className="grid gap-4">
      <form onSubmit={submit} className="flex flex-col gap-3 md:flex-row md:items-start">
        <Field className="md:w-40">
          <FieldLabel htmlFor={roleId}>Role</FieldLabel>
          <Select value={role} onValueChange={(v) => setRole(v as Role)}>
            <SelectTrigger id={roleId} className="w-full" aria-describedby={`${roleId}-hint`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roles.map((r) => (
                <SelectItem key={r} value={r}>
                  {ROLE_INFO[r].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field className="flex-1">
          <FieldLabel htmlFor={emailId}>Email (optional, for your reference)</FieldLabel>
          <Input id={emailId} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Button type="submit" disabled={busy} className="md:mt-[1.375rem]">
          <Link2 />
          {busy ? 'Creating…' : 'Create invite link'}
        </Button>
      </form>
      <FieldDescription id={`${roleId}-hint`}>
        {ROLE_INFO[role].label}: {ROLE_INFO[role].description}
      </FieldDescription>
      {error && <ErrorAlert message={error} />}
      {url && (
        <Alert role="status">
          <Link2 />
          <AlertTitle>Share this link. It’s only shown once.</AlertTitle>
          <AlertDescription>
            <div className="mt-2 w-full">
              <KeyField label="Invite link" value={url} what="invite link" />
            </div>
            <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => setUrl(null)}>
              Done
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function DeleteOrg() {
  const { org, refresh } = useAuth();
  const confirm = useConfirm();
  const announce = useAnnounce();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!org) return null;

  async function del() {
    const ok = await confirm({
      title: `Delete ${org!.name}?`,
      body: 'All of its sites, secrets, API keys, stats, members and invites are deleted permanently. Widgets using its sitekeys stop working.',
      confirmLabel: 'Delete organization',
      danger: true,
      requireText: org!.name,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteOrg(org!.id);
      announce(`Deleted ${org!.name}`);
      await refresh();
      navigate('/sites');
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      <div>
        <Button type="button" variant="destructive" onClick={del} disabled={busy}>
          <Trash2 />
          {busy ? 'Deleting…' : 'Delete organization'}
        </Button>
      </div>
      {error && <ErrorAlert message={error} />}
    </div>
  );
}
