CREATE TABLE IF NOT EXISTS analytics_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics_clients (
  project_name TEXT NOT NULL,
  client_id TEXT NOT NULL,
  reported_client_created_date TEXT,
  client_created_date TEXT NOT NULL,
  client_created_source TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  first_seen_date TEXT NOT NULL,
  first_seen_source TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_seen_date TEXT NOT NULL,
  last_seen_source TEXT NOT NULL,
  first_version TEXT NOT NULL DEFAULT '',
  last_version TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_name, client_id)
);

CREATE INDEX IF NOT EXISTS idx_analytics_clients_project_last_seen
ON analytics_clients (project_name, last_seen_date);

CREATE INDEX IF NOT EXISTS idx_analytics_clients_project_created
ON analytics_clients (project_name, client_created_date);

CREATE TABLE IF NOT EXISTS analytics_daily_client_activity (
  project_name TEXT NOT NULL,
  activity_date TEXT NOT NULL,
  client_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  app_open_count INTEGER NOT NULL DEFAULT 0,
  page_view_count INTEGER NOT NULL DEFAULT 0,
  config_usage_count INTEGER NOT NULL DEFAULT 0,
  ai_request_count INTEGER NOT NULL DEFAULT 0,
  resource_click_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_name, activity_date, client_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_activity_project_client_date
ON analytics_daily_client_activity (project_name, client_id, activity_date);

CREATE TABLE IF NOT EXISTS analytics_monthly_event_stats (
  project_name TEXT NOT NULL,
  month TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'live',
  event TEXT NOT NULL,
  shard INTEGER NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_name, month, source, event, shard)
);

CREATE INDEX IF NOT EXISTS idx_monthly_event_project_month_source
ON analytics_monthly_event_stats (project_name, month, source);

CREATE TABLE IF NOT EXISTS analytics_monthly_page_stats (
  project_name TEXT NOT NULL,
  month TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'live',
  page TEXT NOT NULL,
  shard INTEGER NOT NULL,
  view_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_name, month, source, page, shard)
);

CREATE INDEX IF NOT EXISTS idx_monthly_page_project_page
ON analytics_monthly_page_stats (project_name, page);

CREATE INDEX IF NOT EXISTS idx_monthly_page_project_month_source
ON analytics_monthly_page_stats (project_name, month, source);

CREATE TABLE IF NOT EXISTS analytics_monthly_version_stats (
  project_name TEXT NOT NULL,
  month TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'live',
  version TEXT NOT NULL,
  shard INTEGER NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  app_open_count INTEGER NOT NULL DEFAULT 0,
  page_view_count INTEGER NOT NULL DEFAULT 0,
  config_usage_count INTEGER NOT NULL DEFAULT 0,
  ai_request_count INTEGER NOT NULL DEFAULT 0,
  resource_click_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_name, month, source, version, shard)
);

CREATE INDEX IF NOT EXISTS idx_monthly_version_project_version
ON analytics_monthly_version_stats (project_name, version);

CREATE INDEX IF NOT EXISTS idx_monthly_version_project_month_source
ON analytics_monthly_version_stats (project_name, month, source);

CREATE TABLE IF NOT EXISTS analytics_monthly_config_stats (
  project_name TEXT NOT NULL,
  month TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'live',
  field_key TEXT NOT NULL,
  value TEXT NOT NULL,
  shard INTEGER NOT NULL,
  report_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_name, month, source, field_key, value, shard)
);

CREATE INDEX IF NOT EXISTS idx_monthly_config_project_field_value
ON analytics_monthly_config_stats (project_name, field_key, value);

CREATE INDEX IF NOT EXISTS idx_monthly_config_project_month_source
ON analytics_monthly_config_stats (project_name, month, source);

CREATE TABLE IF NOT EXISTS analytics_monthly_model_stats (
  project_name TEXT NOT NULL,
  month TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'live',
  request_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  endpoint_host TEXT NOT NULL,
  model TEXT NOT NULL,
  shard INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_name, month, source, request_type, provider, endpoint_host, model, shard)
);

CREATE INDEX IF NOT EXISTS idx_monthly_model_project_model
ON analytics_monthly_model_stats (project_name, request_type, provider, endpoint_host, model);

CREATE INDEX IF NOT EXISTS idx_monthly_model_project_month_source
ON analytics_monthly_model_stats (project_name, month, source);

CREATE TABLE IF NOT EXISTS analytics_monthly_resource_stats (
  project_name TEXT NOT NULL,
  month TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'live',
  resource_key TEXT NOT NULL,
  shard INTEGER NOT NULL,
  click_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_name, month, source, resource_key, shard)
);

CREATE INDEX IF NOT EXISTS idx_monthly_resource_project_key
ON analytics_monthly_resource_stats (project_name, resource_key);

CREATE INDEX IF NOT EXISTS idx_monthly_resource_project_month_source
ON analytics_monthly_resource_stats (project_name, month, source);

CREATE TABLE IF NOT EXISTS analytics_dimension_clients (
  project_name TEXT NOT NULL,
  dimension_type TEXT NOT NULL,
  dimension_key TEXT NOT NULL,
  client_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  first_seen_date TEXT NOT NULL,
  first_seen_month TEXT NOT NULL,
  first_seen_source TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_seen_date TEXT NOT NULL,
  last_seen_source TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (project_name, dimension_type, dimension_key, client_id)
);

CREATE INDEX IF NOT EXISTS idx_dimension_clients_lookup
ON analytics_dimension_clients (project_name, dimension_type, dimension_key);

CREATE INDEX IF NOT EXISTS idx_dimension_clients_backfill_cleanup
ON analytics_dimension_clients (project_name, last_seen_source, last_seen_date);

CREATE TABLE IF NOT EXISTS analytics_dimension_client_totals (
  project_name TEXT NOT NULL,
  dimension_type TEXT NOT NULL,
  dimension_key TEXT NOT NULL,
  client_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (project_name, dimension_type, dimension_key)
);

CREATE TABLE IF NOT EXISTS analytics_dimension_values (
  project_name TEXT NOT NULL,
  dimension_type TEXT NOT NULL,
  dimension_key TEXT NOT NULL,
  label TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_name, dimension_type, dimension_key)
);

CREATE TABLE IF NOT EXISTS analytics_processed_events (
  event_id TEXT PRIMARY KEY,
  received_date TEXT NOT NULL,
  status TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_processed_events_received_date
ON analytics_processed_events (received_date);
