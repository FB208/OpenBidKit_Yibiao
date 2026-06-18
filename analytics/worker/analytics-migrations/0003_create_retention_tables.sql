CREATE TABLE IF NOT EXISTS stats_client_activity (
  project_name TEXT NOT NULL,
  activity_date TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_created_date TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_name, activity_date, client_id)
);

CREATE INDEX IF NOT EXISTS idx_stats_client_activity_project_created
ON stats_client_activity (project_name, client_created_date);

CREATE INDEX IF NOT EXISTS idx_stats_client_activity_project_date
ON stats_client_activity (project_name, activity_date);

CREATE TABLE IF NOT EXISTS stats_retention (
  project_name TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  range_days INTEGER NOT NULL,
  retention_day INTEGER NOT NULL,
  cohort_clients INTEGER NOT NULL DEFAULT 0,
  retained_clients INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_name, snapshot_date, range_days, retention_day)
);

CREATE INDEX IF NOT EXISTS idx_stats_retention_project_latest
ON stats_retention (project_name, range_days, snapshot_date);
