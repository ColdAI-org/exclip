-- ExClip shared key-value store in Postgres, for servers without Redis: per-IP rate-limit windows, single-use passkey
-- challenges and the daily new-passkey counter (apps/server/src/kv.ts). With REDIS_URL set these tables stay unused.
-- Apply with: psql "$DATABASE_URL" -f apps/server/migrations/0002_kv.sql
--
-- Every row expires: reads ignore expired rows at once and the server deletes them in the background. Rate-limit
-- keys contain the client's IPv4 address or IPv6 /64 prefix and expire about a minute later; nothing from a request
-- body is stored. Additive and idempotent: new tables and indexes only.
CREATE TABLE IF NOT EXISTS exclip_kv (
  key text PRIMARY KEY,
  value text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS exclip_kv_expires_idx ON exclip_kv (expires_at);

-- Sliding-window rate limits: one row per counted request, scored by its time in milliseconds.
CREATE TABLE IF NOT EXISTS exclip_kv_windows (
  key text NOT NULL,
  member text NOT NULL,
  score bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (key, member)
);

CREATE INDEX IF NOT EXISTS exclip_kv_windows_score_idx ON exclip_kv_windows (key, score);
CREATE INDEX IF NOT EXISTS exclip_kv_windows_expires_idx ON exclip_kv_windows (expires_at);
