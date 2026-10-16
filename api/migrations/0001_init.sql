CREATE TABLE users (
    id            UUID PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sites (
    id          UUID PRIMARY KEY,
    owner_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    sitekey     TEXT NOT NULL UNIQUE,
    -- Secrets are high-entropy random strings, so a plain SHA-256 is sufficient
    -- and lets siteverify look the site up by hash.
    secret_hash TEXT NOT NULL UNIQUE,
    domains     TEXT[] NOT NULL DEFAULT '{}',
    mode        TEXT NOT NULL DEFAULT 'managed'
                CHECK (mode IN ('managed', 'non_interactive', 'invisible')),
    difficulty  SMALLINT NOT NULL DEFAULT 16 CHECK (difficulty BETWEEN 8 AND 24),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sites_owner_idx ON sites(owner_id);

CREATE TABLE site_stats_daily (
    site_id       UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    day           DATE NOT NULL,
    issued        BIGINT NOT NULL DEFAULT 0,
    solved        BIGINT NOT NULL DEFAULT 0,
    failed        BIGINT NOT NULL DEFAULT 0,
    interactive   BIGINT NOT NULL DEFAULT 0,
    verified      BIGINT NOT NULL DEFAULT 0,
    verify_failed BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (site_id, day)
);
