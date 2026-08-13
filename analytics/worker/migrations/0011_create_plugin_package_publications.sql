-- 跨 Worker 请求保护正在发布的插件临时对象和正式对象
CREATE TABLE IF NOT EXISTS plugin_package_publications (
  publication_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (publication_id, object_key)
);

CREATE INDEX IF NOT EXISTS idx_plugin_package_publications_object
  ON plugin_package_publications(object_key, expires_at);
CREATE INDEX IF NOT EXISTS idx_plugin_package_publications_expires
  ON plugin_package_publications(expires_at);

-- 串行化插件包发布、插件删除和全局清理，避免跨 Worker 请求的检查后竞态
CREATE TABLE IF NOT EXISTS plugin_package_operation_locks (
  lock_name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
