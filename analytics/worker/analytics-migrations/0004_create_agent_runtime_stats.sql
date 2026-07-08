CREATE TABLE IF NOT EXISTS stats_agent_runtime (
  project_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  endpoint_host TEXT NOT NULL,
  model TEXT NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  retried_run_count INTEGER NOT NULL DEFAULT 0,
  retry_success_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_name, provider, endpoint_host, model)
);

CREATE INDEX IF NOT EXISTS idx_stats_agent_runtime_project_total
ON stats_agent_runtime (project_name, total_count DESC);
