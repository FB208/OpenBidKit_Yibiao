CREATE TABLE IF NOT EXISTS analytics_daily_event_client_stats (
  project_name TEXT NOT NULL,
  activity_date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'rollup',
  event TEXT NOT NULL,
  client_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_name, activity_date, source, event)
);

CREATE INDEX IF NOT EXISTS idx_daily_event_client_stats_project_event_date
ON analytics_daily_event_client_stats (project_name, event, activity_date);
