-- Secret rotation grace period.
ALTER TABLE sites
    ADD COLUMN previous_secret_hash       TEXT,
    ADD COLUMN previous_secret_expires_at TIMESTAMPTZ;

CREATE INDEX sites_previous_secret_idx ON sites(previous_secret_hash)
    WHERE previous_secret_hash IS NOT NULL;

-- Abuse reports and Private Access Token passes.
ALTER TABLE site_stats_daily
    ADD COLUMN reported BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN pat      BIGINT NOT NULL DEFAULT 0;

-- API keys for the REST API / Terraform provider.
CREATE TABLE api_keys (
    id           UUID PRIMARY KEY,
    owner_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    prefix       TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);

CREATE INDEX api_keys_owner_idx ON api_keys(owner_id);
