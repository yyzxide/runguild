ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'operator'
  CHECK (role IN ('owner', 'operator', 'viewer'));

CREATE TABLE IF NOT EXISTS user_credentials (
  user_id              TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL,
  password_hash        TEXT NOT NULL CHECK (char_length(password_hash) BETWEEN 40 AND 1024),
  credential_version   INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, workspace_id),
  FOREIGN KEY (user_id, workspace_id) REFERENCES users(id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  user_id               TEXT NOT NULL,
  token_hash            TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  csrf_token_hash       TEXT NOT NULL CHECK (csrf_token_hash ~ '^[0-9a-f]{64}$'),
  credential_version    INTEGER NOT NULL CHECK (credential_version > 0),
  source_hash           TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  user_agent_hash       TEXT NOT NULL CHECK (user_agent_hash ~ '^[0-9a-f]{64}$'),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  idle_expires_at       TIMESTAMPTZ NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  revoked_at            TIMESTAMPTZ,
  CHECK (idle_expires_at <= expires_at),
  CHECK (expires_at > created_at),
  FOREIGN KEY (user_id, workspace_id) REFERENCES users(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_active
  ON auth_sessions(token_hash, idle_expires_at, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
  ON auth_sessions(workspace_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_login_attempts (
  key_hash              TEXT PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  principal_hash        TEXT NOT NULL CHECK (principal_hash ~ '^[0-9a-f]{64}$'),
  source_hash           TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  failure_count         INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  window_started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocked_until         TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_cleanup
  ON auth_login_attempts(updated_at);

CREATE TABLE IF NOT EXISTS auth_events (
  id                    BIGSERIAL PRIMARY KEY,
  kind                  TEXT NOT NULL CHECK (kind IN (
    'login_succeeded', 'login_failed', 'login_blocked', 'logout', 'password_changed'
  )),
  principal_hash        TEXT NOT NULL CHECK (principal_hash ~ '^[0-9a-f]{64}$'),
  source_hash           TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  session_id            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_events_principal
  ON auth_events(principal_hash, created_at DESC);
