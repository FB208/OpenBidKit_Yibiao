-- 版本号封禁的墓碑表：对齐 stats_blocked_clients 的思路，防止凌晨定时汇总
-- 从 Analytics Engine 重新读到封禁前的历史事件后，把已清理的客户端重新插回 stats_clients。
CREATE TABLE IF NOT EXISTS stats_blocked_version_clients (
  project_name TEXT NOT NULL,
  client_id TEXT NOT NULL,
  blocked_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_name, client_id, blocked_version)
);

CREATE INDEX IF NOT EXISTS idx_stats_blocked_version_clients_version
ON stats_blocked_version_clients (project_name, blocked_version);
