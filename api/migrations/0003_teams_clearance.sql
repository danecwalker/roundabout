-- Teams: sites and API keys belong to organizations with role-based members.

ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false;
UPDATE users SET is_admin = true WHERE id = (SELECT id FROM users ORDER BY created_at LIMIT 1);

CREATE TABLE orgs (
    id          UUID PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    legacy_user UUID
);

CREATE TABLE org_members (
    org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id)
);
CREATE INDEX org_members_user_idx ON org_members(user_id);

CREATE TABLE org_invites (
    id         UUID PRIMARY KEY,
    org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    email      TEXT,
    token_hash TEXT NOT NULL UNIQUE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX org_invites_org_idx ON org_invites(org_id);

-- Every existing user gets a personal org that takes over their sites and keys.
INSERT INTO orgs (id, name, legacy_user) SELECT gen_random_uuid(), 'Personal', id FROM users;
INSERT INTO org_members (org_id, user_id, role) SELECT id, legacy_user, 'owner' FROM orgs;

ALTER TABLE sites ADD COLUMN org_id UUID REFERENCES orgs(id) ON DELETE CASCADE;
UPDATE sites s SET org_id = o.id FROM orgs o WHERE o.legacy_user = s.owner_id;
ALTER TABLE sites ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE sites DROP COLUMN owner_id;
CREATE INDEX sites_org_idx ON sites(org_id);

ALTER TABLE api_keys ADD COLUMN org_id UUID REFERENCES orgs(id) ON DELETE CASCADE;
ALTER TABLE api_keys ADD COLUMN created_by UUID REFERENCES users(id) ON DELETE SET NULL;
UPDATE api_keys k SET org_id = o.id, created_by = k.owner_id FROM orgs o WHERE o.legacy_user = k.owner_id;
ALTER TABLE api_keys ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE api_keys DROP COLUMN owner_id;
CREATE INDEX api_keys_org_idx ON api_keys(org_id);

ALTER TABLE orgs DROP COLUMN legacy_user;

-- Pre-clearance.
ALTER TABLE sites
    ADD COLUMN clearance_enabled  BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN clearance_ttl_secs INT NOT NULL DEFAULT 1800
        CHECK (clearance_ttl_secs BETWEEN 300 AND 86400);

-- Long-lived server signing keys (clearance cookies).
CREATE TABLE server_keys (
    kid        TEXT PRIMARY KEY,
    purpose    TEXT NOT NULL,
    secret     BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
