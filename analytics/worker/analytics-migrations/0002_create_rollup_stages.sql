CREATE TABLE IF NOT EXISTS stats_rollup_stages (
  project_name TEXT NOT NULL,
  activity_date TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_name, activity_date, stage)
);
