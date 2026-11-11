-- 客户端按需下载的功能组件（如文字识别运行库和模型），同一依赖可按平台登记多份安装包
CREATE TABLE IF NOT EXISTS dependencies (
  id TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'all',
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL,
  download_url TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id, platform)
);

CREATE INDEX IF NOT EXISTS idx_dependencies_enabled ON dependencies(enabled);
