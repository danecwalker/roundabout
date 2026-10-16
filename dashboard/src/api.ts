export type Mode = 'managed' | 'non_interactive' | 'invisible';
export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export interface OrgRef {
  id: string;
  name: string;
  role: Role;
}

export interface User {
  id: string;
  email: string;
  created_at: string;
  is_admin: boolean;
  orgs: OrgRef[];
}

export interface Org extends OrgRef {
  created_at: string;
  member_count: number;
}

export interface Member {
  user_id: string;
  email: string;
  role: Role;
  joined_at: string;
}

export interface Invite {
  id: string;
  role: Role;
  email: string | null;
  created_at: string;
  expires_at: string;
  invited_by: string | null;
}

export interface InviteInfo {
  org_name: string;
  role: Role;
  invited_by: string | null;
  expires_at: string;
}

export interface Site {
  id: string;
  name: string;
  sitekey: string;
  domains: string[];
  mode: Mode;
  difficulty: number;
  clearance_enabled: boolean;
  clearance_ttl_secs: number;
  created_at: string;
  updated_at: string;
  previous_secret_expires_at: string | null;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  created_by: string | null;
}

export interface SiteInput {
  name: string;
  domains: string[];
  mode: Mode;
  difficulty: number;
  clearance_enabled: boolean;
  clearance_ttl_secs: number;
}

export interface StatsDay {
  day: string;
  issued: number;
  solved: number;
  failed: number;
  interactive: number;
  verified: number;
  verify_failed: number;
  reported: number;
  pat: number;
}

export interface VerifyResult {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  'error-codes': string[];
  action?: string;
  cdata?: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Org sent as `X-Org-Id` on site and API-key requests. Set by the auth context. */
let currentOrgId: string | null = null;

export function setApiOrg(id: string | null) {
  currentOrgId = id;
}

function orgScoped(path: string): boolean {
  return path.startsWith('/api/sites') || path.startsWith('/api/keys');
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const init: RequestInit = { method, credentials: 'same-origin', headers };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  if (currentOrgId && orgScoped(path)) headers['X-Org-Id'] = currentOrgId;
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'Network error. Is the API running?');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
  }
  if (!res.ok) {
    const err = (data as { error?: unknown } | undefined)?.error;
    const msg = typeof err === 'string' && err ? err : `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  signup: (email: string, password: string, invite?: string) =>
    request<User>('POST', '/api/auth/signup', invite ? { email, password, invite } : { email, password }),
  login: (email: string, password: string) => request<User>('POST', '/api/auth/login', { email, password }),
  logout: () => request<void>('POST', '/api/auth/logout'),
  me: () => request<User>('GET', '/api/auth/me'),
  config: () => request<{ signup_enabled: boolean }>('GET', '/api/config'),

  listSites: () => request<Site[]>('GET', '/api/sites'),
  createSite: (input: SiteInput) => request<{ site: Site; secret: string }>('POST', '/api/sites', input),
  getSite: (id: string) => request<Site>('GET', `/api/sites/${id}`),
  updateSite: (id: string, input: Partial<SiteInput>) => request<Site>('PATCH', `/api/sites/${id}`, input),
  deleteSite: (id: string) => request<void>('DELETE', `/api/sites/${id}`),
  rotateSecret: (id: string, graceHours: number) =>
    request<{ secret: string; previous_secret_expires_at: string | null }>('POST', `/api/sites/${id}/rotate-secret`, {
      grace_hours: graceHours,
    }),
  revokePreviousSecret: (id: string) => request<void>('POST', `/api/sites/${id}/revoke-previous-secret`),
  stats: (id: string, days = 30) => request<{ days: StatsDay[] }>('GET', `/api/sites/${id}/stats?days=${days}`),
  testVerify: (id: string, response: string) =>
    request<VerifyResult>('POST', `/api/sites/${id}/test-verify`, { response }),

  listKeys: () => request<ApiKey[]>('GET', '/api/keys'),
  createKey: (name: string) => request<{ key: ApiKey; token: string }>('POST', '/api/keys', { name }),
  deleteKey: (id: string) => request<void>('DELETE', `/api/keys/${id}`),

  listOrgs: () => request<Org[]>('GET', '/api/orgs'),
  createOrg: (name: string) => request<Org>('POST', '/api/orgs', { name }),
  renameOrg: (id: string, name: string) => request<Org>('PATCH', `/api/orgs/${id}`, { name }),
  deleteOrg: (id: string) => request<void>('DELETE', `/api/orgs/${id}`),
  listMembers: (orgId: string) => request<Member[]>('GET', `/api/orgs/${orgId}/members`),
  setMemberRole: (orgId: string, userId: string, role: Role) =>
    request<Member>('PATCH', `/api/orgs/${orgId}/members/${userId}`, { role }),
  removeMember: (orgId: string, userId: string) => request<void>('DELETE', `/api/orgs/${orgId}/members/${userId}`),
  listInvites: (orgId: string) => request<Invite[]>('GET', `/api/orgs/${orgId}/invites`),
  createInvite: (orgId: string, role: Role, email?: string) =>
    request<{ invite: Invite; url: string }>('POST', `/api/orgs/${orgId}/invites`, email ? { role, email } : { role }),
  revokeInvite: (orgId: string, inviteId: string) => request<void>('DELETE', `/api/orgs/${orgId}/invites/${inviteId}`),
  getInvite: (token: string) => request<InviteInfo>('GET', `/api/invites/${enc(token)}`),
  acceptInvite: (token: string) => request<Org>('POST', `/api/invites/${enc(token)}/accept`),
};

export const MODE_INFO: Record<Mode, { label: string; description: string }> = {
  managed: {
    label: 'Managed',
    description: 'Auto-solves; asks for a click only when signals look suspicious.',
  },
  non_interactive: {
    label: 'Non-interactive',
    description: 'Always auto-solves with a visible spinner.',
  },
  invisible: {
    label: 'Invisible',
    description: 'No UI at all. Runs silently in the background.',
  },
};

export const ROLE_INFO: Record<Role, { label: string; description: string }> = {
  owner: { label: 'Owner', description: 'Everything, including granting ownership and deleting the organization.' },
  admin: { label: 'Admin', description: 'Manage sites, secrets, API keys, invites and members.' },
  member: { label: 'Member', description: 'Create and edit sites, use Try it.' },
  viewer: { label: 'Viewer', description: 'Read-only access to sites and stats.' },
};

export const CLEARANCE_TTLS: { secs: number; label: string }[] = [
  { secs: 300, label: '5 minutes' },
  { secs: 900, label: '15 minutes' },
  { secs: 1800, label: '30 minutes' },
  { secs: 3600, label: '1 hour' },
  { secs: 14400, label: '4 hours' },
  { secs: 86400, label: '24 hours' },
];

export function ttlLabel(secs: number): string {
  return CLEARANCE_TTLS.find((t) => t.secs === secs)?.label ?? `${Math.round(secs / 60)} minutes`;
}
