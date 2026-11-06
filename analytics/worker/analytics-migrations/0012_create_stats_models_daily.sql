-- 按天保留模型用量明细，供 7天/30天 等窗口查询直接按日求和，不再每次实时扫 Analytics Engine。
-- 另含完成哨兵行（request_type/provider/endpoint_host/model 全为空）：某天全部模型分块写完后落库，
-- 查询侧按哨兵判断该日期是否"完整"汇总，无哨兵的日期自动回退到 AE 补齐，不产生数据空洞。
CREATE TABLE IF NOT EXISTS stats_models_daily (
  project_name TEXT NOT NULL,
  activity_date TEXT NOT NULL,
  request_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  endpoint_host TEXT NOT NULL,
  model TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_name, activity_date, request_type, provider, endpoint_host, model)
);

CREATE INDEX IF NOT EXISTS idx_stats_models_daily_project_date
ON stats_models_daily (project_name, activity_date, request_type);
