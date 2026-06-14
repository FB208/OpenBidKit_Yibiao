CREATE TABLE IF NOT EXISTS stats_totals (
  project_name TEXT PRIMARY KEY,
  total_clients INTEGER NOT NULL DEFAULT 0,
  total_open INTEGER NOT NULL DEFAULT 0,
  total_page_views INTEGER NOT NULL DEFAULT 0,
  total_events INTEGER NOT NULL DEFAULT 0,
  total_ai_requests INTEGER NOT NULL DEFAULT 0,
  last_rollup_date TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stats_clients (
  project_name TEXT NOT NULL,
  client_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  first_seen_date TEXT NOT NULL,
  active_days INTEGER NOT NULL DEFAULT 0,
  last_active_date TEXT NOT NULL DEFAULT '',
  last_active_version TEXT NOT NULL DEFAULT '',
  last_access_ip TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_name, client_id)
);

CREATE INDEX IF NOT EXISTS idx_stats_clients_project_first_seen
ON stats_clients (project_name, first_seen_date);

CREATE INDEX IF NOT EXISTS idx_stats_clients_project_last_active
ON stats_clients (project_name, last_active_date);

CREATE TABLE IF NOT EXISTS stats_daily (
  project_name TEXT NOT NULL,
  activity_date TEXT NOT NULL,
  active_clients INTEGER NOT NULL DEFAULT 0,
  app_open_count INTEGER NOT NULL DEFAULT 0,
  page_view_count INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  ai_request_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_name, activity_date)
);

CREATE TABLE IF NOT EXISTS stats_pages (
  project_name TEXT NOT NULL,
  page TEXT NOT NULL,
  view_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_name, page)
);

CREATE TABLE IF NOT EXISTS stats_versions (
  project_name TEXT NOT NULL,
  version TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  client_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_name, version)
);

CREATE TABLE IF NOT EXISTS stats_configs (
  project_name TEXT NOT NULL,
  field_key TEXT NOT NULL,
  value TEXT NOT NULL,
  report_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_name, field_key, value)
);

CREATE TABLE IF NOT EXISTS stats_models (
  project_name TEXT NOT NULL,
  request_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  endpoint_host TEXT NOT NULL,
  model TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_name, request_type, provider, endpoint_host, model)
);

CREATE INDEX IF NOT EXISTS idx_stats_models_project_filters
ON stats_models (project_name, request_type, provider, endpoint_host, model);

CREATE TABLE IF NOT EXISTS stats_rollup_runs (
  project_name TEXT NOT NULL,
  activity_date TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_name, activity_date)
);
