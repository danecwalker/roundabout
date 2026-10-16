import type { Role } from './api';

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function atLeast(role: Role | undefined, min: Role): boolean {
  return role !== undefined && RANK[role] >= RANK[min];
}

/** What the current role may do. The server enforces the same rules. */
export function permissions(role: Role | undefined) {
  return {
    editSites: atLeast(role, 'member'),
    tryIt: atLeast(role, 'member'),
    deleteSites: atLeast(role, 'admin'),
    manageSecrets: atLeast(role, 'admin'),
    manageKeys: atLeast(role, 'admin'),
    manageTeam: atLeast(role, 'admin'),
    owner: role === 'owner',
  };
}

export type Permissions = ReturnType<typeof permissions>;
