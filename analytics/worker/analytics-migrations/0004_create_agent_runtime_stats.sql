CREATE TABLE IF NOT EXISTS stats_agent_runtime (
  project_name TEXT NOT NULL,
  status TEXT NOT NULL,
  run_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_name, status)
);
