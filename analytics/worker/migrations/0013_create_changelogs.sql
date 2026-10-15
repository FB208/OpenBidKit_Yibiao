CREATE TABLE IF NOT EXISTS changelogs (
  id TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  version TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_name, version)
);

CREATE INDEX IF NOT EXISTS idx_changelogs_project_created
ON changelogs (project_name, created_at DESC);
