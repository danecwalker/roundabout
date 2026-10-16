import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, setApiOrg, type OrgRef, type User } from './api';
import { permissions, type Permissions } from './roles';

const ORG_KEY = 'roundabout.org';

function readStoredOrg(): string | null {
  try {
    return localStorage.getItem(ORG_KEY);
  } catch {
    return null;
  }
}

function storeOrg(id: string | null) {
  try {
    if (id) localStorage.setItem(ORG_KEY, id);
    else localStorage.removeItem(ORG_KEY);
  } catch {
    /* storage unavailable */
  }
}

interface AuthState {
  user: User | null;
  loading: boolean;
  bootError: string | null;
  orgs: OrgRef[];
  org: OrgRef | null;
  can: Permissions;
  setOrg: (id: string) => void;
  /** Re-fetch the current user (and org memberships). */
  refresh: () => Promise<User | null>;
  login: (email: string, password: string) => Promise<User>;
  signup: (email: string, password: string, invite?: string) => Promise<User>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

function pickOrg(user: User | null, preferred: string | null): string | null {
  if (!user || user.orgs.length === 0) return null;
  if (preferred && user.orgs.some((o) => o.id === preferred)) return preferred;
  return user.orgs[0].id;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);

  const applyUser = useCallback((u: User | null, preferred?: string | null) => {
    const normalized = u ? { ...u, orgs: u.orgs ?? [] } : null;
    const id = pickOrg(normalized, preferred ?? readStoredOrg());
    setApiOrg(id);
    storeOrg(id);
    setOrgId(id);
    setUserState(normalized);
  }, []);

  useEffect(() => {
    api
      .me()
      .then((u) => applyUser(u))
      .catch((e: unknown) => {
        if (!(e instanceof ApiError && e.status === 401)) {
          setBootError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => setLoading(false));
  }, [applyUser]);

  const setOrg = useCallback(
    (id: string) => {
      if (!user?.orgs.some((o) => o.id === id)) return;
      setApiOrg(id);
      storeOrg(id);
      setOrgId(id);
    },
    [user],
  );

  const refresh = useCallback(async () => {
    try {
      const u = await api.me();
      applyUser(u, orgId);
      return u;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        applyUser(null);
        return null;
      }
      throw e;
    }
  }, [applyUser, orgId]);

  const login = useCallback(
    async (email: string, password: string) => {
      const u = await api.login(email, password);
      applyUser(u);
      return u;
    },
    [applyUser],
  );
  const signup = useCallback(
    async (email: string, password: string, invite?: string) => {
      const u = await api.signup(email, password, invite);
      applyUser(u);
      return u;
    },
    [applyUser],
  );
  const logout = useCallback(async () => {
    await api.logout();
    applyUser(null);
  }, [applyUser]);

  const value = useMemo<AuthState>(() => {
    const orgs = user?.orgs ?? [];
    const org = orgs.find((o) => o.id === orgId) ?? null;
    return {
      user,
      loading,
      bootError,
      orgs,
      org,
      can: permissions(org?.role),
      setOrg,
      refresh,
      login,
      signup,
      logout,
    };
  }, [user, orgId, loading, bootError, setOrg, refresh, login, signup, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
