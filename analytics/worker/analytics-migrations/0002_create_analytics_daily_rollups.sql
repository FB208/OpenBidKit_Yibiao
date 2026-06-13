CREATE TABLE IF NOT EXISTS analytics_daily_summary (
  project_name TEXT NOT NULL,
  activity_date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'rollup',
  event_count INTEGER NOT NULL DEFAULT 0,
  app_open_count INTEGER NOT NULL DEFAULT 0,
  page_view_count INTEGER NOT NULL DEFAULT 0,
  config_usage_count INTEGER NOT NULL DEFAULT 0,
  ai_request_count INTEGER NOT NULL DEFAULT 0,
  resource_click_count INTEGER NOT NULL DEFAULT 0,
  active_clients INTEGER NOT NULL DEFAULT 0,
  new_clients INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT NOT NULL DEFAULT '',
  rolled_up_at TEXT NOT NULL,
  PRIMARY KEY (project_name, activity_date, source)
);

CREATE INDEX IF NOT EXISTS idx_daily_summary_project_date
ON analytics_daily_summary (project_name, activity_date);

CREATE TABLE IF NOT EXISTS analytics_daily_page_stats (
  project_name TEXT NOT NULL,
  activity_date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'rollup',
  page TEXT NOT NULL,
  view_count INTEGER NOT NULL DEFAULT 0,
  client_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_name, activity_date, source, page)
);

CREATE TABLE IF NOT EXISTS analytics_daily_version_stats (
  project_name TEXT NOT NULL,
  activity_date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'rollup',
  version TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  app_open_count INTEGER NOT NULL DEFAULT 0,
  page_view_count INTEGER NOT NULL DEFAULT 0,
  config_usage_count INTEGER NOT NULL DEFAULT 0,
  ai_request_count INTEGER NOT NULL DEFAULT 0,
  resource_click_count INTEGER NOT NULL DEFAULT 0,
  client_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_name, activity_date, source, version)
);

CREATE TABLE IF NOT EXISTS analytics_daily_config_stats (
  project_name TEXT NOT NULL,
  activity_date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'rollup',
  field_key TEXT NOT NULL,
  value TEXT NOT NULL,
  report_count INTEGER NOT NULL DEFAULT 0,
  client_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_name, activity_date, source, field_key, value)
);

CREATE TABLE IF NOT EXISTS analytics_daily_model_stats (
  project_name TEXT NOT NULL,
  activity_date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'rollup',
  request_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  endpoint_host TEXT NOT NULL,
  model TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  client_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_name, activity_date, source, request_type, provider, endpoint_host, model)
);

CREATE TABLE IF NOT EXISTS analytics_daily_resource_stats (
  project_name TEXT NOT NULL,
  activity_date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'rollup',
  resource_key TEXT NOT NULL,
  click_count INTEGER NOT NULL DEFAULT 0,
  client_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_name, activity_date, source, resource_key)
);

CREATE TABLE IF NOT EXISTS analytics_client_index (
  project_name TEXT NOT NULL,
  client_hash TEXT NOT NULL,
  reported_client_created_date TEXT,
  client_created_date TEXT NOT NULL,
  client_created_source TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  first_seen_date TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_seen_date TEXT NOT NULL,
  first_version TEXT NOT NULL DEFAULT '',
  last_version TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_name, client_hash)
);

CREATE INDEX IF NOT EXISTS idx_client_index_project_last_seen
ON analytics_client_index (project_name, last_seen_date);

CREATE INDEX IF NOT EXISTS idx_client_index_project_created
ON analytics_client_index (project_name, client_created_date);

CREATE TABLE IF NOT EXISTS analytics_dimension_client_index (
  project_name TEXT NOT NULL,
  dimension_type TEXT NOT NULL,
  dimension_key TEXT NOT NULL,
  client_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  first_seen_date TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_seen_date TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_name, dimension_type, dimension_key, client_hash)
);

CREATE INDEX IF NOT EXISTS idx_dimension_client_index_lookup
ON analytics_dimension_client_index (project_name, dimension_type, dimension_key);
