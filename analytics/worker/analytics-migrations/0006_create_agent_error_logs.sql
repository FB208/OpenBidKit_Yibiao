CREATE TABLE IF NOT EXISTS agent_error_settings (
  project_name TEXT PRIMARY KEY,
  receive_enabled INTEGER NOT NULL DEFAULT 0,
  retention_days INTEGER NOT NULL DEFAULT 7,
  max_storage_bytes INTEGER NOT NULL DEFAULT 2147483648,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_error_versions (
  project_name TEXT NOT NULL,
  version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_name, version)
);

CREATE TABLE IF NOT EXISTS agent_error_logs (
  id TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_created_at TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL,
  runtime TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  error_name TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_summary TEXT NOT NULL DEFAULT '',
  original_bytes INTEGER NOT NULL DEFAULT 0,
  compressed_bytes INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready'
);

CREATE INDEX IF NOT EXISTS idx_agent_error_logs_project_received
ON agent_error_logs (project_name, status, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_error_logs_expiry
ON agent_error_logs (status, expires_at);
