-- Every row of personal data carries user_id; every query filters by it.
CREATE TABLE users (
  id TEXT PRIMARY KEY,                 -- random, also the WebAuthn user handle
  name TEXT NOT NULL,                  -- display label only
  recovery_hash TEXT,                  -- SHA-256 of the one-time recovery code
  export_through INTEGER,              -- newest visit time of the last fully uploaded Safari export
  data_version INTEGER NOT NULL DEFAULT 1, -- bumped when visits are deleted, so browser caches resync
  created INTEGER NOT NULL
);
CREATE TABLE credentials (             -- passkeys
  id TEXT PRIMARY KEY,                 -- credential id (base64url)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,            -- base64url COSE key
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX credentials_user ON credentials(user_id);
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,            -- SHA-256 of the cookie value
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE tokens (                  -- per-device upload keys (userscript, Shortcut)
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,                  -- e.g. "iPhone"
  created INTEGER NOT NULL,
  last_used INTEGER
);
CREATE INDEX tokens_user ON tokens(user_id);
CREATE TABLE challenges (              -- short-lived WebAuthn challenges
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  user_id TEXT,
  name TEXT,
  expires INTEGER NOT NULL
);
CREATE TABLE urls (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  UNIQUE (user_id, url)
);
CREATE TABLE visits (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  t INTEGER NOT NULL,                  -- unix seconds
  url_id INTEGER NOT NULL REFERENCES urls(id) ON DELETE CASCADE,
  source INTEGER NOT NULL,             -- 1 = live (userscript), 2 = Safari export
  device TEXT,                         -- token id for live visits
  private INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL,              -- when the server stored it; browsers sync by this
  PRIMARY KEY (user_id, url_id, t)
) WITHOUT ROWID;
CREATE INDEX visits_user_t ON visits(user_id, t);
CREATE INDEX visits_user_added ON visits(user_id, added, t, url_id);
CREATE TABLE lists (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL
);
CREATE TABLE install_links (           -- 10-minute links that hand a new upload key to the userscript
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  expires INTEGER NOT NULL
);
