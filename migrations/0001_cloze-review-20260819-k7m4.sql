CREATE TABLE IF NOT EXISTS "cloze-review-20260819-k7m4_records" (
  user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('review_item', 'annotation', 'setting')),
  item_key TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  payload_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'client',
  client_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, entity_type, item_key)
);

CREATE TABLE IF NOT EXISTS "cloze-review-20260819-k7m4_changes" (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  item_key TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  payload_version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  client_id TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS "cloze-review-20260819-k7m4_changes_user_seq"
  ON "cloze-review-20260819-k7m4_changes" (user_id, seq);

CREATE TABLE IF NOT EXISTS "cloze-review-20260819-k7m4_sessions" (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  github_avatar_url TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "cloze-review-20260819-k7m4_sessions_user"
  ON "cloze-review-20260819-k7m4_sessions" (user_id, expires_at);

CREATE TABLE IF NOT EXISTS "cloze-review-20260819-k7m4_oauth_states" (
  state_hash TEXT PRIMARY KEY,
  return_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "cloze-review-20260819-k7m4_auth_codes" (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  github_avatar_url TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "cloze-review-20260819-k7m4_user_mappings" (
  old_provider TEXT NOT NULL,
  old_user_id TEXT NOT NULL,
  new_provider TEXT NOT NULL,
  new_user_id TEXT NOT NULL,
  mapped_at TEXT NOT NULL,
  confirmation_basis TEXT NOT NULL,
  PRIMARY KEY (old_provider, old_user_id),
  UNIQUE (new_provider, new_user_id)
);

CREATE TABLE IF NOT EXISTS "cloze-review-20260819-k7m4_rate_limits" (
  bucket_key TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL,
  window_started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "cloze-review-20260819-k7m4_diagnostics" (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  sync_count INTEGER NOT NULL DEFAULT 0,
  pull_pages INTEGER NOT NULL DEFAULT 0,
  pushed_records INTEGER NOT NULL DEFAULT 0,
  pulled_records INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, day)
);
