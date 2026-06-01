-- 技术方案 SQLite 最新完整数据结构
--
-- 说明：
-- 1. 本文件用于开源开发者阅读、评审和排查问题，展示“技术方案”模块当前设计的完整表结构。
-- 2. 用户运行客户端时不需要手动执行本文件。
-- 3. 客户端运行时建表和升级以 Electron Main 侧 migration 代码为准。
-- 4. 每次表结构调整后，需要同步更新本文件和 migration 版本。
-- 5. 本文件不存储历史版本，每次更新都写入最新的完整数据结构。

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

-- 当前完整结构版本。
-- 运行时代码应通过 PRAGMA user_version 判断是否需要自动升级。
PRAGMA user_version = 1;

-- 技术方案单例元数据。
-- 只保留一行 id = 1，用于保存当前步骤、招标文件 Markdown 元数据、模式配置和正文生成运行时 JSON。
-- 招标文件 Markdown 原文不进入 SQLite，保存到 userData/workspace/technical-plan/tender.md。
CREATE TABLE IF NOT EXISTS technical_plan_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),

  -- 当前技术方案步骤：document-analysis / bid-analysis / outline-generation / content-edit / expand。
  step TEXT NOT NULL DEFAULT 'document-analysis',

  -- 招标文件展示名称，通常是用户上传文件的文件名。
  tender_file_name TEXT,

  -- 解析后 Markdown 文件路径。建议存相对 workspace 的路径，避免 userData 目录变化后失效。
  tender_markdown_path TEXT,

  -- Markdown 内容 hash，用于判断招标文件是否变化。
  tender_markdown_hash TEXT,

  -- Markdown 字符数，用于页面展示和排查大文件问题。
  tender_markdown_chars INTEGER NOT NULL DEFAULT 0,

  -- 本次导入使用的解析器显示名称，例如“本地解析”或“MinerU 精准解析 API”。
  tender_parser_label TEXT,

  -- 招标文件导入时间，ISO 字符串。
  tender_imported_at TEXT,

  -- 招标文件解析模式：key / full。
  bid_analysis_mode TEXT NOT NULL DEFAULT 'key',

  -- 目录生成模式：aligned / free。
  outline_mode TEXT NOT NULL DEFAULT 'aligned',

  -- 目录生成结果中的项目名称。
  outline_project_name TEXT,

  -- 目录生成时使用的项目概述快照。
  outline_project_overview TEXT,

  -- 正文生成配置 JSON，对应 Renderer 的 ContentGenerationOptions。
  content_generation_options_json TEXT,

  -- 正文生成运行时 JSON，用于暂停、继续和应用重启后的状态恢复。
  content_generation_runtime_json TEXT,

  -- 创建时间，ISO 字符串。
  created_at TEXT NOT NULL,

  -- 更新时间，ISO 字符串。
  updated_at TEXT NOT NULL
);

-- 技术方案后台任务状态。
-- 保存 Step02 招标文件解析、Step03 目录生成、Step04 正文生成的任务状态。
CREATE TABLE IF NOT EXISTS technical_plan_tasks (
  -- 任务类型：bid-analysis / outline-generation / content-generation。
  type TEXT PRIMARY KEY,

  -- 当前任务 ID。
  task_id TEXT NOT NULL,

  -- 任务状态：running / pausing / paused / success / error。
  status TEXT NOT NULL,

  -- 任务进度，0-100。
  progress INTEGER NOT NULL DEFAULT 0,

  -- 任务日志 JSON 数组。只保存必要日志，避免无限增长。
  logs_json TEXT,

  -- 任务统计 JSON，例如正文生成阶段、字数、图片数量等。
  stats_json TEXT,

  -- 失败原因。
  error TEXT,

  -- 是否请求暂停。SQLite 没有独立 boolean 类型，使用 0 / 1。
  pause_requested INTEGER NOT NULL DEFAULT 0,

  -- 任务开始时间，ISO 字符串。
  started_at TEXT NOT NULL,

  -- 任务更新时间，ISO 字符串。
  updated_at TEXT NOT NULL
);

-- 招标文件解析项。
-- 每个解析项单独一行，避免更新一个解析结果时重写完整技术方案状态。
CREATE TABLE IF NOT EXISTS technical_plan_bid_items (
  -- 解析项 ID，例如 projectOverview / techRequirements / projectInfo。
  item_id TEXT PRIMARY KEY,

  -- 解析项中文名称。
  label TEXT NOT NULL,

  -- 解析状态：idle / running / success / error。
  status TEXT NOT NULL,

  -- 解析结果 Markdown 或 JSON 字符串。
  content TEXT NOT NULL DEFAULT '',

  -- 失败原因。
  error TEXT,

  -- 展示排序。
  sort_order INTEGER NOT NULL DEFAULT 0,

  -- 更新时间，ISO 字符串。
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_technical_plan_bid_items_order
ON technical_plan_bid_items(sort_order);

-- 技术方案选中的参考知识库文档。
-- 只保存文档 ID，文档内容仍由知识库模块负责读取。
CREATE TABLE IF NOT EXISTS technical_plan_reference_docs (
  -- 知识库文档 ID。
  document_id TEXT PRIMARY KEY,

  -- 选择顺序。
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_technical_plan_reference_docs_order
ON technical_plan_reference_docs(sort_order);

-- 技术方案目录树节点。
-- 目录结构和正文内容的权威来源。
CREATE TABLE IF NOT EXISTS technical_plan_outline_nodes (
  -- 节点 ID，继续使用当前章节编号，例如 1 / 1.1 / 1.1.1。
  node_id TEXT PRIMARY KEY,

  -- 父节点 ID。一级目录为 NULL。
  parent_node_id TEXT,

  -- 同级排序，从 0 开始。
  sort_order INTEGER NOT NULL,

  -- 目录层级。一级目录为 1，二级为 2，三级为 3。
  level INTEGER NOT NULL,

  -- 目录标题。
  title TEXT NOT NULL,

  -- 目录描述。
  description TEXT NOT NULL DEFAULT '',

  -- 对齐模式下绑定的技术评分大类 ID。
  source_requirement_id TEXT,

  -- 对齐模式下绑定的技术评分大类标题。
  source_requirement_title TEXT,

  -- 绑定的知识库条目 ID JSON 数组。
  knowledge_item_ids_json TEXT,

  -- 章节正文内容。只有叶子小节通常会有正文。
  content TEXT NOT NULL DEFAULT '',

  -- 创建时间，ISO 字符串。
  created_at TEXT NOT NULL,

  -- 更新时间，ISO 字符串。
  updated_at TEXT NOT NULL,

  FOREIGN KEY (parent_node_id) REFERENCES technical_plan_outline_nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_technical_plan_outline_parent_order
ON technical_plan_outline_nodes(parent_node_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_technical_plan_outline_level
ON technical_plan_outline_nodes(level);

-- 正文生成小节状态。
-- 不重复保存正文内容，正文内容在 technical_plan_outline_nodes.content。
CREATE TABLE IF NOT EXISTS technical_plan_content_sections (
  -- 目录节点 ID，对应 technical_plan_outline_nodes.node_id。
  node_id TEXT PRIMARY KEY,

  -- 小节生成状态：idle / running / success / error。
  status TEXT NOT NULL DEFAULT 'idle',

  -- 失败原因。
  error TEXT,

  -- 更新时间，ISO 字符串。
  updated_at TEXT NOT NULL,

  FOREIGN KEY (node_id) REFERENCES technical_plan_outline_nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_technical_plan_content_sections_status
ON technical_plan_content_sections(status);

-- 正文编排计划。
-- 每个叶子小节一条，保存 AI 决策出的表格、Mermaid、AI 生图和知识库引用计划。
CREATE TABLE IF NOT EXISTS technical_plan_content_plans (
  -- 目录节点 ID，对应 technical_plan_outline_nodes.node_id。
  node_id TEXT PRIMARY KEY,

  -- 正文编排计划 JSON，对应 ContentGenerationPlanData。
  plan_json TEXT NOT NULL,

  -- 最终采用的配图类型：ai / mermaid / none。
  illustration_type TEXT NOT NULL DEFAULT 'none',

  -- 更新时间，ISO 字符串。
  updated_at TEXT NOT NULL,

  FOREIGN KEY (node_id) REFERENCES technical_plan_outline_nodes(node_id) ON DELETE CASCADE
);
