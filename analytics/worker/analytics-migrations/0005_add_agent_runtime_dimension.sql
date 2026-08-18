CREATE TABLE stats_agent_runtime_with_runtime (
  project_name TEXT NOT NULL,
  runtime TEXT NOT NULL,
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
  PRIMARY KEY (project_name, runtime, provider, endpoint_host, model)
);

INSERT INTO stats_agent_runtime_with_runtime (
  project_name, runtime, provider, endpoint_host, model,
  success_count, failed_count, total_count,
  retry_count, retried_run_count, retry_success_count, updated_at
)
SELECT
  project_name, 'opencode', provider, endpoint_host, model,
  success_count, failed_count, total_count,
  retry_count, retried_run_count, retry_success_count, updated_at
FROM stats_agent_runtime;

DROP TABLE stats_agent_runtime;
ALTER TABLE stats_agent_runtime_with_runtime RENAME TO stats_agent_runtime;

CREATE INDEX idx_stats_agent_runtime_project_total
ON stats_agent_runtime (project_name, total_count DESC);
