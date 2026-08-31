CREATE TABLE IF NOT EXISTS stats_blocked_clients (
  project_name TEXT NOT NULL,
  client_id TEXT NOT NULL,
  blocked_ip TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_name, client_id, blocked_ip)
);

CREATE INDEX IF NOT EXISTS idx_stats_blocked_clients_ip
ON stats_blocked_clients (blocked_ip);

CREATE TABLE IF NOT EXISTS ip_blocks (
  ip TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ip_block_storage_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  kv_migrated_at TEXT NOT NULL
);
