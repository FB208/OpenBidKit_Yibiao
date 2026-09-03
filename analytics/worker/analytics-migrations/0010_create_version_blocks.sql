CREATE TABLE IF NOT EXISTS version_blocks (
  project_name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_name, version)
);
