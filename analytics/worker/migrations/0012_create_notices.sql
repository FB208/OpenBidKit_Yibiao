CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY,
  client_notice_id TEXT NOT NULL UNIQUE,
  project_name TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  delivered_user_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notices_project_updated
ON notices (project_name, updated_at DESC);
