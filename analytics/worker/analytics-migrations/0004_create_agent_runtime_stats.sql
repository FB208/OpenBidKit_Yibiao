CREATE TABLE IF NOT EXISTS stats_agent_runtime (
  project_name TEXT PRIMARY KEY,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  retried_run_count INTEGER NOT NULL DEFAULT 0,
  retry_success_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
