import { useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Building2, ChevronsUpDown, Globe, KeyRound, LogOut, Plus, Users } from 'lucide-react';
import { api } from '../api';
import { useAnnounce, useId } from '../a11y';
import { useAuth } from '../auth';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import Logo from './Logo';
import Modal from './Modal';

const NAV = [
  { to: '/sites', label: 'Sites', icon: Globe },
  { to: '/keys', label: 'API keys', icon: KeyRound },
  { to: '/team', label: 'Team', icon: Users },
];

export default function Layout() {
  const { org } = useAuth();
  const [creating, setCreating] = useState(false);

  return (
    <SidebarProvider>
      <a
        href="#main"
        className="bg-primary text-primary-foreground sr-only z-50 rounded-md px-4 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to main content
      </a>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <OrgSwitcher onCreate={() => setCreating(true)} />
        </SidebarHeader>
        <SidebarContent>
          <MainNav />
        </SidebarContent>
        <SidebarFooter>
          <UserMenu />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <Link to="/sites" className="flex items-center gap-2 font-semibold">
            <Logo size={20} />
            Roundabout
          </Link>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 p-4 outline-none md:p-8">
          {org ? <Outlet key={org.id} /> : <NoOrg onCreate={() => setCreating(true)} />}
        </main>
      </SidebarInset>
      <CreateOrgDialog open={creating} onClose={() => setCreating(false)} />
    </SidebarProvider>
  );
}

function MainNav() {
  const { pathname } = useLocation();
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Manage</SidebarGroupLabel>
      <SidebarGroupContent>
        <nav aria-label="Main">
          <SidebarMenu>
            {NAV.map((n) => (
              <SidebarMenuItem key={n.to}>
                <SidebarMenuButton asChild isActive={pathname.startsWith(n.to)} tooltip={n.label}>
                  <NavLink to={n.to} onClick={() => setOpenMobile(false)}>
                    <n.icon />
                    <span>{n.label}</span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </nav>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function OrgSwitcher({ onCreate }: { onCreate: () => void }) {
  const { orgs, org, setOrg } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const announce = useAnnounce();
  const { isMobile } = useSidebar();

  function switchOrg(id: string) {
    setOrg(id);
    announce(`Switched to ${orgs.find((o) => o.id === id)?.name ?? ''}`);
    // A site page belongs to the previous org.
    if (/^\/sites\/(?!new)/.test(location.pathname)) navigate('/sites');
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg">
              <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                <Building2 className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{org?.name ?? 'No organization'}</span>
                <span className="text-muted-foreground truncate text-xs capitalize">{org?.role ?? ''}</span>
              </div>
              <ChevronsUpDown className="ml-auto" />
              <span className="sr-only">Switch organization</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            align="start"
            side={isMobile ? 'bottom' : 'right'}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-muted-foreground text-xs">Organizations</DropdownMenuLabel>
            {orgs.map((o) => (
              <DropdownMenuItem key={o.id} onSelect={() => switchOrg(o.id)} className="gap-2 p-2">
                <div className="flex size-6 items-center justify-center rounded-md border">
                  <Building2 className="size-3.5 shrink-0" />
                </div>
                <span className="truncate">{o.name}</span>
                {o.id === org?.id && <span className="text-muted-foreground ml-auto text-xs">Current</span>}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onCreate} className="gap-2 p-2">
              <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                <Plus className="size-4" />
              </div>
              <span className="text-muted-foreground font-medium">New organization</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { isMobile } = useSidebar();
  const initial = (user?.email ?? '?').charAt(0).toUpperCase();

  async function onLogout() {
    await logout();
    navigate('/login');
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg">
              <Avatar className="size-8 rounded-lg">
                <AvatarFallback className="rounded-lg">{initial}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{user?.email}</span>
                {user?.is_admin && <span className="text-muted-foreground truncate text-xs">Instance admin</span>}
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
              <span className="sr-only">Account menu</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? 'bottom' : 'right'}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="truncate font-normal">{user?.email}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onLogout}>
              <LogOut />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function NoOrg({ onCreate }: { onCreate: () => void }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyTitle>
          <h1>You’re not in an organization</h1>
        </EmptyTitle>
        <EmptyDescription>Create one, or ask a teammate for an invite link.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onCreate}>Create organization</Button>
      </EmptyContent>
    </Empty>
  );
}

export function CreateOrgDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { refresh, setOrg } = useAuth();
  const announce = useAnnounce();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId('org-name');

  function close() {
    setName('');
    setError(null);
    onClose();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError('Enter a name for the organization.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.createOrg(name.trim());
      await refresh();
      setOrg(created.id);
      announce(`Created organization ${created.name}`);
      close();
      navigate('/sites');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="Create organization" description="Organizations own sites and API keys. You’ll be its owner." onClose={close}>
      <form onSubmit={submit} noValidate>
        <FieldGroup>
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor={inputId}>Name</FieldLabel>
            <Input id={inputId} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required aria-invalid={!!error} />
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create organization'}
            </Button>
          </div>
        </FieldGroup>
      </form>
    </Modal>
  );
}
