-- ExClip passkey wallet: the server half of the passkey-only wallet.
-- Apply with: psql "$DATABASE_URL" -f apps/server/migrations/0001_wallet.sql
--
-- exclip_wallet_credentials: one row per passkey, holding only its WebAuthn public key and counters. The server
-- never receives a PRF output, a recovery phrase, a vault password or a wallet address.
-- exclip_wallet_backups: ciphertext from the ClipVault passkey backup (decryptable only with the passkey's PRF
-- output), append-only versions per credential; reads return the newest. "Delete" through the API sets retired_at;
-- the server purges retired credentials (and, by cascade, their backups) 30 days later.
-- No emails, IP addresses or wallet addresses are stored. Additive and idempotent: new tables only.
-- Apply BEFORE the server starts with the passkey wallet on (features.embeddedWallet): its routes read and write
-- these tables.
CREATE TABLE IF NOT EXISTS exclip_wallet_credentials (
  credential_id text PRIMARY KEY CHECK (credential_id ~ '^[A-Za-z0-9_-]+$' AND char_length(credential_id) BETWEEN 16 AND 512),
  public_key bytea NOT NULL CHECK (octet_length(public_key) BETWEEN 16 AND 1024),
  rp_id text NOT NULL,
  sign_count bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  retired_at timestamptz
);

CREATE TABLE IF NOT EXISTS exclip_wallet_backups (
  id bigserial PRIMARY KEY,
  credential_id text NOT NULL REFERENCES exclip_wallet_credentials (credential_id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  blob bytea NOT NULL CHECK (octet_length(blob) BETWEEN 1 AND 16384),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (credential_id, version)
);

CREATE INDEX IF NOT EXISTS exclip_wallet_credentials_retired_idx
  ON exclip_wallet_credentials (retired_at) WHERE retired_at IS NOT NULL;

-- Append-only: a stored backup version is never rewritten (only the 30-day purge deletes, by cascade).
CREATE OR REPLACE FUNCTION exclip_wallet_backups_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'exclip_wallet_backups is append-only';
END;
$$;

DROP TRIGGER IF EXISTS exclip_wallet_backups_append_only ON exclip_wallet_backups;
CREATE TRIGGER exclip_wallet_backups_append_only
  BEFORE UPDATE ON exclip_wallet_backups
  FOR EACH ROW EXECUTE FUNCTION exclip_wallet_backups_no_update();
