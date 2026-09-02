CREATE TABLE IF NOT EXISTS version_blocks (
  project_name TEXT NOT NULL,
  version TEXT NOT NULL COLLATE BINARY,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_name, version)
);

CREATE TABLE IF NOT EXISTS block_rule_history (
  rule_type TEXT NOT NULL CHECK (rule_type IN ('ip', 'version')),
  project_name TEXT NOT NULL DEFAULT '',
  rule_value TEXT NOT NULL,
  excluded_until TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (rule_type, project_name, rule_value)
);

CREATE TABLE IF NOT EXISTS block_rule_cleanup_progress (
  rule_type TEXT NOT NULL CHECK (rule_type IN ('ip', 'version')),
  project_name TEXT NOT NULL,
  rule_value TEXT NOT NULL,
  cleaned_until TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (rule_type, project_name, rule_value)
);

CREATE TABLE IF NOT EXISTS block_rule_cleanup_locks (
  project_name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);
