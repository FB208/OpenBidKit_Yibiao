CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  modal_content TEXT NOT NULL DEFAULT '',
  image_key TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_resources_enabled_sort
ON resources (enabled, sort_order, updated_at);
