-- 工作区 SQLite 目标完整数据结构（设计说明）
--
-- 说明：
-- 1. 本文件用于开源开发者阅读、评审和排查问题，展示 workspace/yibiao.sqlite 的目标完整表结构。
-- 2. 用户运行客户端时不需要手动执行本文件。
-- 3. 客户端运行时建表和升级以 Electron Main 侧 migration 代码为准。
-- 4. 当前运行代码已落地 technical_plan_* v1、duplicate_check_* / rejection_check_* v2、knowledge_* v3、technical_plan_global_fact_groups v4、标段兼容 v5/v6、标段选择 v7 和待选择标段恢复状态 v8 目标结构。
-- 5. 每次表结构调整后，需要同步更新本文件和 runtime migration 版本。
-- 6. 本文件不保存历史版本，每次更新都写入最新目标完整结构。

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

-- 目标完整结构版本。
-- 运行时代码应通过 PRAGMA user_version 判断是否需要自动升级。
PRAGMA user_version = 8;

-- ============================================================================
-- 技术方案 technical_plan_*（v1 已落地）
-- ============================================================================

-- 技术方案单例元数据。
-- 只保留一行 id = 1，用于保存当前步骤、招标文件 Markdown 元数据、Step 内 pending 子状态、模式配置和正文生成运行时 JSON。
-- 招标文件 Markdown 原文不进入 SQLite，保存到 userData/workspace/technical-plan/tender.md。
-- 多标段待选择 Markdown 原文同样不进入 SQLite，保存到 userData/workspace/technical-plan/tender-pending-*.tmp.md，并由 pending_tender_* 字段记录恢复状态。
CREATE TABLE IF NOT EXISTS technical_plan_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  step TEXT NOT NULL DEFAULT 'document-analysis',
  tender_file_name TEXT,
  tender_markdown_path TEXT,
  tender_markdown_hash TEXT,
  tender_markdown_chars INTEGER NOT NULL DEFAULT 0,
  tender_parser_label TEXT,
  tender_imported_at TEXT,
  -- v8 Step01 多标段待选择恢复状态
  pending_tender_markdown_path TEXT,
  pending_tender_file_name TEXT,
  pending_tender_parser_label TEXT,
  pending_tender_sections_json TEXT,
  pending_tender_total_declared INTEGER,
  pending_tender_created_at TEXT,
  bid_analysis_mode TEXT NOT NULL DEFAULT 'key',
  outline_mode TEXT NOT NULL DEFAULT 'aligned',
  outline_project_name TEXT,
  outline_project_overview TEXT,
  content_generation_options_json TEXT,
  content_generation_runtime_json TEXT,
  -- v6 兼容字段（旧版客户端遗留，新代码不再使用但保留以兼容）
  current_bid_section_id TEXT,
  bid_sections_extracted INTEGER,
  -- v7 标段选择字段
  selected_section_id TEXT,
  selected_section_title TEXT,
  selected_section_head_line TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 技术方案后台任务状态。
CREATE TABLE IF NOT EXISTS technical_plan_tasks (
  type TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  logs_json TEXT,
  stats_json TEXT,
  error TEXT,
  pause_requested INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 技术方案招标文件解析项。
CREATE TABLE IF NOT EXISTS technical_plan_bid_items (
  item_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  error TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_technical_plan_bid_items_order
ON technical_plan_bid_items(sort_order);

-- 技术方案选中的参考知识库文档。
CREATE TABLE IF NOT EXISTS technical_plan_reference_docs (
  document_id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_technical_plan_reference_docs_order
ON technical_plan_reference_docs(sort_order);

-- 技术方案目录树节点。
-- 目录结构和正文内容的权威来源。
CREATE TABLE IF NOT EXISTS technical_plan_outline_nodes (
  node_id TEXT PRIMARY KEY,
  parent_node_id TEXT,
  sort_order INTEGER NOT NULL,
  level INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_requirement_id TEXT,
  source_requirement_title TEXT,
  knowledge_item_ids_json TEXT,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (parent_node_id) REFERENCES technical_plan_outline_nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_technical_plan_outline_parent_order
ON technical_plan_outline_nodes(parent_node_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_technical_plan_outline_level
ON technical_plan_outline_nodes(level);

-- 技术方案正文生成小节状态。
-- 不重复保存正文内容，正文内容在 technical_plan_outline_nodes.content。
CREATE TABLE IF NOT EXISTS technical_plan_content_sections (
  node_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'idle',
  error TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (node_id) REFERENCES technical_plan_outline_nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_technical_plan_content_sections_status
ON technical_plan_content_sections(status);

-- 技术方案正文编排计划。
CREATE TABLE IF NOT EXISTS technical_plan_content_plans (
  node_id TEXT PRIMARY KEY,
  plan_json TEXT NOT NULL,
  illustration_type TEXT NOT NULL DEFAULT 'none',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (node_id) REFERENCES technical_plan_outline_nodes(node_id) ON DELETE CASCADE
);

-- 技术方案全局事实大项。
-- 用于在正文生成前统一约束人员资质、供货周期、金额数字、品牌型号等全文一致性事实。
CREATE TABLE IF NOT EXISTS technical_plan_global_fact_groups (
  group_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_technical_plan_global_fact_groups_order
ON technical_plan_global_fact_groups(sort_order);

-- ============================================================================
-- 标书查重 duplicate_check_*（v2 目标设计）
-- ============================================================================

-- 标书查重单例页面状态。
CREATE TABLE IF NOT EXISTS duplicate_check_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  step TEXT NOT NULL DEFAULT 'upload',
  active_analysis_tab TEXT NOT NULL DEFAULT 'metadata',
  current_signature TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 标书查重当前文件选择。
-- role: tender / bid。招标文件可为空，投标文件至少一份才能开始分析。
CREATE TABLE IF NOT EXISTS duplicate_check_files (
  file_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  extension TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  modified_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_duplicate_check_files_role_order
ON duplicate_check_files(role, sort_order);

-- 标书查重外层后台任务状态。
CREATE TABLE IF NOT EXISTS duplicate_check_tasks (
  type TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  logs_json TEXT,
  stats_json TEXT,
  error TEXT,
  payload_signature TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 标书查重四类分析子状态。
-- section: metadata / outline / content / image。
CREATE TABLE IF NOT EXISTS duplicate_check_analysis_sections (
  section TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  signature TEXT,
  stats_json TEXT,
  started_at TEXT,
  updated_at TEXT NOT NULL
);

-- 标书查重 Markdown 正文提取结果。
-- Markdown 原文保存到 userData/workspace/duplicate-check/contents/<fileId>.md。
CREATE TABLE IF NOT EXISTS duplicate_check_content_files (
  file_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  content_path TEXT,
  content_length INTEGER NOT NULL DEFAULT 0,
  parser_label TEXT,
  error TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (file_id) REFERENCES duplicate_check_files(file_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_duplicate_check_content_files_status
ON duplicate_check_content_files(status);

-- 标书查重元数据项。
CREATE TABLE IF NOT EXISTS duplicate_check_metadata_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  normalized TEXT,
  date_day TEXT,
  comparable INTEGER NOT NULL DEFAULT 0,
  date_comparable INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (file_id) REFERENCES duplicate_check_files(file_id) ON DELETE CASCADE,
  UNIQUE(file_id, key)
);

CREATE INDEX IF NOT EXISTS idx_duplicate_check_metadata_file_order
ON duplicate_check_metadata_items(file_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_duplicate_check_metadata_key
ON duplicate_check_metadata_items(key);

-- 标书查重目录提取项。
-- 业务目录项 ID 仅在单个文件内唯一，落库时 item_id / parent_item_id 使用 file_id::item_id 作用域 ID。
CREATE TABLE IF NOT EXISTS duplicate_check_outline_items (
  item_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  parent_item_id TEXT,
  level INTEGER NOT NULL,
  number TEXT,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  path_titles_json TEXT NOT NULL,
  normalized_path TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  from_tender INTEGER NOT NULL DEFAULT 0,
  matched_tender_sentence TEXT,
  FOREIGN KEY (file_id) REFERENCES duplicate_check_files(file_id) ON DELETE CASCADE,
  FOREIGN KEY (parent_item_id) REFERENCES duplicate_check_outline_items(item_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_duplicate_check_outline_file_order
ON duplicate_check_outline_items(file_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_duplicate_check_outline_normalized
ON duplicate_check_outline_items(normalized_title, normalized_path);

-- 标书查重目录重复/相似组。
CREATE TABLE IF NOT EXISTS duplicate_check_outline_groups (
  group_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  file_ids_json TEXT NOT NULL,
  item_ids_json TEXT NOT NULL,
  paths_json TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_duplicate_check_outline_groups_order
ON duplicate_check_outline_groups(sort_order);

-- 标书查重目录两两相似度。
CREATE TABLE IF NOT EXISTS duplicate_check_outline_pairwise (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_a_id TEXT NOT NULL,
  file_b_id TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  title_overlap REAL NOT NULL DEFAULT 0,
  path_overlap REAL NOT NULL DEFAULT 0,
  order_similarity REAL NOT NULL DEFAULT 0,
  shared_count INTEGER NOT NULL DEFAULT 0,
  risk TEXT NOT NULL DEFAULT 'none',
  FOREIGN KEY (file_a_id) REFERENCES duplicate_check_files(file_id) ON DELETE CASCADE,
  FOREIGN KEY (file_b_id) REFERENCES duplicate_check_files(file_id) ON DELETE CASCADE,
  UNIQUE(file_a_id, file_b_id)
);

CREATE INDEX IF NOT EXISTS idx_duplicate_check_outline_pairwise_score
ON duplicate_check_outline_pairwise(score DESC);

-- 标书查重正文重复句。
CREATE TABLE IF NOT EXISTS duplicate_check_content_duplicates (
  duplicate_id TEXT PRIMARY KEY,
  sentence TEXT NOT NULL,
  normalized TEXT NOT NULL,
  file_ids_json TEXT NOT NULL,
  first_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_duplicate_check_content_duplicates_order
ON duplicate_check_content_duplicates(first_order);

-- 标书查重重复句在文件中的出现次数。
CREATE TABLE IF NOT EXISTS duplicate_check_content_occurrences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  duplicate_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (duplicate_id) REFERENCES duplicate_check_content_duplicates(duplicate_id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES duplicate_check_files(file_id) ON DELETE CASCADE,
  UNIQUE(duplicate_id, file_id)
);

CREATE INDEX IF NOT EXISTS idx_duplicate_check_content_occ_file
ON duplicate_check_content_occurrences(file_id);

-- 标书查重单文件图片统计。
CREATE TABLE IF NOT EXISTS duplicate_check_image_files (
  file_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  image_count INTEGER NOT NULL DEFAULT 0,
  unique_image_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (file_id) REFERENCES duplicate_check_files(file_id) ON DELETE CASCADE
);

-- 标书查重重复图片组。
CREATE TABLE IF NOT EXISTS duplicate_check_duplicate_images (
  image_id TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  preview_url TEXT NOT NULL,
  file_ids_json TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_duplicate_check_duplicate_images_hash
ON duplicate_check_duplicate_images(hash);

CREATE INDEX IF NOT EXISTS idx_duplicate_check_duplicate_images_order
ON duplicate_check_duplicate_images(sort_order);

-- 标书查重重复图片在文件中的出现次数和位置。
CREATE TABLE IF NOT EXISTS duplicate_check_image_occurrences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  locations_json TEXT,
  FOREIGN KEY (image_id) REFERENCES duplicate_check_duplicate_images(image_id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES duplicate_check_files(file_id) ON DELETE CASCADE,
  UNIQUE(image_id, file_id)
);

CREATE INDEX IF NOT EXISTS idx_duplicate_check_image_occ_file
ON duplicate_check_image_occurrences(file_id);

-- ============================================================================
-- 废标项检查 rejection_check_*（v2 目标设计）
-- ============================================================================

-- 废标项检查单例页面状态。
CREATE TABLE IF NOT EXISTS rejection_check_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  step TEXT NOT NULL DEFAULT 'documents',
  active_document_tab TEXT NOT NULL DEFAULT 'tender',
  active_result_tab TEXT NOT NULL DEFAULT 'analysis',
  active_check_result_tab TEXT NOT NULL DEFAULT 'rejection',
  custom_check_items TEXT NOT NULL DEFAULT '',
  check_options_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 废标项检查招标/投标文档元数据。
-- Markdown 原文不进入 SQLite，保存到 userData/workspace/rejection-check/tender.md 或 bid.md。
CREATE TABLE IF NOT EXISTS rejection_check_documents (
  role TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  file_name TEXT NOT NULL,
  markdown_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_chars INTEGER NOT NULL DEFAULT 0,
  parser_label TEXT,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 废标项检查后台任务状态。
CREATE TABLE IF NOT EXISTS rejection_check_tasks (
  type TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  logs_json TEXT,
  stats_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 无效投标与废标项解析结果。
CREATE TABLE IF NOT EXISTS rejection_check_extraction (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'idle',
  content TEXT NOT NULL DEFAULT '',
  source TEXT,
  tender_signature TEXT,
  error TEXT,
  updated_at TEXT
);

-- 三类检查结果状态。
-- result_type: rejection / typo / logic。
CREATE TABLE IF NOT EXISTS rejection_check_results (
  result_type TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'idle',
  input_signature TEXT,
  active_finding_id TEXT,
  progress_message TEXT,
  error TEXT,
  updated_at TEXT
);

-- 废标项检查风险结果。
CREATE TABLE IF NOT EXISTS rejection_check_risk_findings (
  finding_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  requirement TEXT NOT NULL,
  bid_evidence TEXT NOT NULL,
  risk_reason TEXT NOT NULL,
  suggestion TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rejection_check_risk_order
ON rejection_check_risk_findings(sort_order);

CREATE INDEX IF NOT EXISTS idx_rejection_check_risk_severity
ON rejection_check_risk_findings(severity);

-- 错别字检查结果。
CREATE TABLE IF NOT EXISTS rejection_check_typo_findings (
  finding_id TEXT PRIMARY KEY,
  wrong_text TEXT NOT NULL,
  correct_text TEXT NOT NULL,
  original_excerpt TEXT NOT NULL,
  reason TEXT NOT NULL,
  location_hint TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rejection_check_typo_order
ON rejection_check_typo_findings(sort_order);

-- 逻辑谬误检查结果。
CREATE TABLE IF NOT EXISTS rejection_check_logic_findings (
  finding_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  original_text TEXT NOT NULL,
  location_hint TEXT NOT NULL,
  fallacy_reason TEXT NOT NULL,
  suggestion TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rejection_check_logic_order
ON rejection_check_logic_findings(sort_order);

-- ============================================================================
-- 知识库 knowledge_*（v3 目标设计）
-- ============================================================================

-- 旧知识库数据迁移状态。
-- 旧数据来源是 userData/workspace/knowledge-base/index.json 和每文档结果 JSON。
-- 用户进入知识库页面后确认迁移；迁移成功并校验后删除旧 index.json 和每文档结果 JSON。
CREATE TABLE IF NOT EXISTS knowledge_migration_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  legacy_index_hash TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  migrated_folder_count INTEGER NOT NULL DEFAULT 0,
  migrated_document_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  cleanup_completed_at TEXT,
  error TEXT
);

-- 知识库文件夹。
CREATE TABLE IF NOT EXISTS knowledge_folders (
  folder_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_folders_order
ON knowledge_folders(sort_order, created_at);

-- 知识库文档元数据和处理状态。
-- 原始文件和 Markdown 原文仍保存在 knowledge-base/folders/<folderId>/documents/<documentId>/ 下。
CREATE TABLE IF NOT EXISTS knowledge_documents (
  document_id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  document_dir TEXT NOT NULL,
  source_path TEXT NOT NULL,
  markdown_path TEXT NOT NULL,
  markdown_hash TEXT,
  markdown_chars INTEGER NOT NULL DEFAULT 0,
  source_extension TEXT,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  error TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  block_count INTEGER NOT NULL DEFAULT 0,
  filtered_block_count INTEGER NOT NULL DEFAULT 0,
  candidate_item_count INTEGER NOT NULL DEFAULT 0,
  discarded_block_count INTEGER NOT NULL DEFAULT 0,
  system_discarded_after_retry_count INTEGER NOT NULL DEFAULT 0,
  last_batch_size INTEGER,
  parser_label TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (folder_id) REFERENCES knowledge_folders(folder_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_folder_order
ON knowledge_documents(folder_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_status
ON knowledge_documents(status);

-- 知识库有效 block 和筛除 block。
-- is_filtered = 0 表示进入 AI 分析的有效 block；is_filtered = 1 表示程序筛除的 block。
CREATE TABLE IF NOT EXISTS knowledge_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  type TEXT NOT NULL,
  heading_path_json TEXT,
  content TEXT NOT NULL,
  content_chars INTEGER NOT NULL DEFAULT 0,
  is_filtered INTEGER NOT NULL DEFAULT 0,
  filter_reason TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(document_id) ON DELETE CASCADE,
  UNIQUE(document_id, block_id, is_filtered)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_blocks_document_order
ON knowledge_blocks(document_id, is_filtered, sort_order);

CREATE INDEX IF NOT EXISTS idx_knowledge_blocks_block_id
ON knowledge_blocks(document_id, block_id);

-- 知识库候选条目。
-- 来源包括首轮提取、补充提取和补漏新增；当前实现可先用 source 记录 first/supplement/recovery。
CREATE TABLE IF NOT EXISTS knowledge_candidate_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  source TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(document_id) ON DELETE CASCADE,
  UNIQUE(document_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_candidate_items_document_order
ON knowledge_candidate_items(document_id, sort_order);

-- 知识库最终条目。
-- item_id 仍保持单文档内 K000001 形式；跨文档引用由服务层返回 documentId::itemId。
CREATE TABLE IF NOT EXISTS knowledge_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  title TEXT NOT NULL,
  resume TEXT NOT NULL,
  content TEXT NOT NULL,
  source_file TEXT,
  content_chars INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(document_id) ON DELETE CASCADE,
  UNIQUE(document_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_items_document_order
ON knowledge_items(document_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_knowledge_items_title
ON knowledge_items(title);

-- 最终条目引用的来源 block。
CREATE TABLE IF NOT EXISTS knowledge_item_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(document_id) ON DELETE CASCADE,
  UNIQUE(document_id, item_id, block_id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_item_blocks_item_order
ON knowledge_item_blocks(document_id, item_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_knowledge_item_blocks_block
ON knowledge_item_blocks(document_id, block_id);

-- AI 舍弃和系统重试后舍弃的 block 组。
-- source: ai / system。
CREATE TABLE IF NOT EXISTS knowledge_discarded_groups (
  group_id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL,
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  block_ids_json TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(document_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_knowledge_discarded_document_order
ON knowledge_discarded_groups(document_id, source, sort_order);

-- 知识库分析报告。
CREATE TABLE IF NOT EXISTS knowledge_reports (
  document_id TEXT PRIMARY KEY,
  total_blocks INTEGER NOT NULL DEFAULT 0,
  filtered_blocks_count INTEGER NOT NULL DEFAULT 0,
  candidate_items_count INTEGER NOT NULL DEFAULT 0,
  final_items_count INTEGER NOT NULL DEFAULT 0,
  matched_blocks_count INTEGER NOT NULL DEFAULT 0,
  discarded_blocks_count INTEGER NOT NULL DEFAULT 0,
  system_discarded_after_retry_count INTEGER NOT NULL DEFAULT 0,
  new_items_from_recovery_count INTEGER NOT NULL DEFAULT 0,
  recovery_attempt_count INTEGER NOT NULL DEFAULT 0,
  batch_size INTEGER NOT NULL DEFAULT 20,
  coverage_rate REAL NOT NULL DEFAULT 0,
  matched_rate REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(document_id) ON DELETE CASCADE
);
