# 知识库 SQLite 改造方案

## 1. 改造目标

本方案记录 `client/` 中“知识库”模块从旧文件型索引迁入 SQLite 的设计。当前只先落文档、SQL 说明和开发约定；运行代码后续按本方案实施。

核心目标：

- 将知识库索引和分析结果从 `userData/workspace/knowledge-base/index.json` 以及每文档 JSON 文件，迁入 `userData/workspace/yibiao.sqlite`。
- 保留用户已经上传且处理完成的知识库资料，升级后首次进入知识库时提示用户确认迁移；非完成状态文档会被明确提示并跳过迁移。
- 迁移过程由客户端自动完成，用户确认后迁移，迁移过程中提示不要关闭软件。
- 迁移成功且校验通过后删除旧索引和结果 JSON，下次进入知识库不再触发迁移弹窗。
- Markdown 原文和原始上传文件继续作为文件保存，SQLite 只保存路径、hash、字符数、状态和结构化分析结果。
- 知识库现有 Renderer API 和页面交互尽量保持不变，优先在 Main 侧替换持久化实现。

最终期望效果：

- 知识库列表、文档状态、候选条目、最终条目、block、舍弃记录和报告都可从 SQLite 局部读取。
- 技术方案 Step03/Step04 继续通过 `knowledgeBaseService.getOutlineReferences()` 和 `readItems()` 读取知识库引用，不感知底层迁移。
- 旧 JSON 文件只作为用户确认后的迁移来源，不作为长期 fallback。

## 2. 改造范围

本次纳入设计范围：

- 知识库文件夹和文档索引。
- 文档处理状态、进度、错误、计数和调试读取口径。
- 有效 block、筛除 block、候选知识条目、最终知识条目、条目来源 block、舍弃记录、分析报告。
- 旧 `index.json` 和每文档 JSON 的用户确认迁移流程。
- `knowledge-base:*` IPC、preload、Renderer 类型的目标边界。
- SQLite schema v3 目标结构。
- 文件路径、清理规则、验证标准。

本次不纳入范围：

- 知识库 AI 提示词和匹配算法重构。
- 技术方案引用知识库的业务算法重构。
- 图片资产存储方式重构。
- 配置 `user_config.json` 迁移。
- 将知识库任务立即接入统一 `taskService.cjs`。

## 3. 当前旧数据结构

当前知识库主要保存在：

```text
userData/workspace/knowledge-base/
  index.json
  folders/
    <folderId>/
      documents/
        <documentId>/
          source.<ext>
          content.md
          blocks.json
          filtered_blocks.json
          candidate_items.json
          match_result.json
          report.json
          items.json
```

旧文件含义：

- `index.json`：文件夹列表和文档列表，是旧版权威索引。
- `source.<ext>`：用户上传的原始文件副本。
- `content.md`：解析后的 Markdown 原文。
- `blocks.json`：有效 block。
- `filtered_blocks.json`：程序筛除的 block。
- `candidate_items.json`：AI 两轮提取和补充后的候选知识条目。
- `match_result.json`：批次匹配、补漏、新增条目、AI 舍弃和系统舍弃结果。
- `report.json`：分析报告。
- `items.json`：最终知识条目。

## 4. 统一数据库

继续使用已有工作区数据库：

```text
userData/workspace/yibiao.sqlite
```

目标版本：

```sql
PRAGMA user_version = 3;
```

版本约定：

- v1：技术方案 `technical_plan_*` 表。
- v2：标书查重 `duplicate_check_*` 表和废标项检查 `rejection_check_*` 表。
- v3：知识库 `knowledge_*` 表和知识库迁移元数据表。

运行时代码仍必须以 Electron Main 侧 migration 为准；根目录 `sql/workspace_schema.sql` 只作为开源开发者阅读、评审和排查问题的说明文件。

## 5. 大文本和文件边界

SQLite 保存结构化状态，不保存大段 Markdown 原文。

保留为文件：

```text
userData/workspace/knowledge-base/folders/<folderId>/documents/<documentId>/source.<ext>
userData/workspace/knowledge-base/folders/<folderId>/documents/<documentId>/content.md
```

SQLite 保存：

- `source_path` 和 `markdown_path` 相对路径。
- Markdown hash、字符数、解析器标签、导入时间。
- 文档处理状态和计数。
- block、候选条目、最终条目、来源关系、舍弃记录、报告。

图片资产：

- 继续保存到 `workspace/imported-images/`。
- Markdown 中继续使用 `yibiao-asset://imported-images/...` 引用。
- SQLite 不保存图片 BLOB。
- 删除知识库文档时继续调用 `deleteImportedImageBatches(app, assetScopePrefix)` 清理对应图片批次，`assetScopePrefix` 使用 `knowledge-${documentId}`。

## 6. 迁移触发流程

知识库迁移必须由用户进入知识库页面后显式确认。

页面初始化流程：

1. `KnowledgeBasePage` 首次加载时调用 `window.yibiao.knowledgeBase.getMigrationStatus()`。
2. Main 侧检测旧 `workspace/knowledge-base/index.json` 是否存在。
3. 如果旧索引存在、SQLite 中尚未完成迁移、旧 JSON 清理也未完成，则返回 `needsMigration: true`。
4. Renderer 使用项目内 Radix Dialog 弹出迁移确认弹窗，不使用 `window.confirm` 等系统弹窗；弹窗必须明确提示只迁移已完成文档，未完成或处理中文档会被丢弃。弹窗排版应包含标题、旧版不再支持处理提示、迁移规则警告和文档数量统计，例如：

```text
新版本知识库需要进行数据迁移。
检测到旧知识库文档 N 个，其中已完成 X 个，未完成或处理中 Y 个。
当前版本已经不支持继续处理旧版知识库。如有未处理完成的文档，请先回退旧版本，将所有知识库文档解析为“已完成”状态后，再更新并执行迁移。
请先确认旧版知识库解析已完成后再继续；本次只迁移状态为“已完成”的文档，未完成或处理中的文档会被丢弃（不会迁移到新版本知识库）。
迁移过程自动完成，过程中不要关闭软件，是否开始？
```

5. 用户点击“开始”后调用 `window.yibiao.knowledgeBase.migrateLegacy()`。
6. 迁移期间禁用上传、删除、重命名、查看、匹配等知识库操作。
7. 迁移成功后刷新 `knowledgeBase.list()`，展示迁移后的旧知识库已完成文档。
8. 用户点击“稍后”时不迁移、不清理旧数据，下次进入知识库继续提示。

迁移成功后的行为：

- 删除旧 `index.json`。
- 删除旧索引中每个文档目录下的旧结果 JSON。
- 旧索引中非 `success` 文档不写入 SQLite，新版本知识库不再展示这些未完成文档。
- 保留 `source.<ext>`、`content.md`、导入图片资产和开发者日志。
- 下次进入知识库时，因为旧 `index.json` 已不存在，不再触发弹窗。

## 7. 迁移状态 API

目标新增 preload API：

```ts
window.yibiao.knowledgeBase.getMigrationStatus()
window.yibiao.knowledgeBase.migrateLegacy()
```

目标类型：

```ts
export interface KnowledgeBaseMigrationStatus {
  needsMigration: boolean;
  legacyFolderCount: number;
  legacyDocumentCount: number;
  legacyCompletedDocumentCount?: number;
  legacySkippedDocumentCount?: number;
  migrationCompleted?: boolean;
  cleanupPending?: boolean;
  message?: string;
}

export interface KnowledgeBaseMigrationResult {
  success: boolean;
  message: string;
  index?: KnowledgeBaseIndex;
  migratedFolderCount?: number;
  migratedDocumentCount?: number;
  skippedDocumentCount?: number;
  cleanupPending?: boolean;
}
```

IPC 命名：

- `knowledge-base:get-migration-status`
- `knowledge-base:migrate-legacy`

## 8. 迁移步骤

Main 侧 `migrateLegacy()` 执行步骤：

1. 检测 `workspace/knowledge-base/index.json`。
2. 读取并规范化旧 `folders` 和 `documents`。
3. 将旧文档按状态分为 `success` 与非完成状态；只迁移 `success` 文档，非完成状态计入跳过数量。
4. 逐个 `success` 文档读取旧结果文件。
5. 在 SQLite 事务中写入 v3 表。
6. 事务提交前重新从 SQLite 读取文件夹数、已迁移文档数和关键结果数。
7. 校验迁移数量与旧索引中的 `success` 文档一致。
8. 校验通过后删除旧 `index.json` 和每文档旧结果 JSON。
9. 写入 `knowledge_migration_meta`，记录迁移完成时间和清理完成时间。
10. 返回新的 `KnowledgeBaseIndex` 和跳过文档数量。

每文档迁移口径：

- 只迁移旧索引中 `status = success` 的文档。
- `blocks.json` 写入 `knowledge_blocks`，`is_filtered = 0`。
- `filtered_blocks.json` 写入 `knowledge_blocks`，`is_filtered = 1`，保留 `filter_reason`。
- `candidate_items.json` 写入 `knowledge_candidate_items`。
- `items.json` 写入 `knowledge_items` 和 `knowledge_item_blocks`。
- `match_result.json.discarded` 写入 `knowledge_discarded_groups`，`source = 'ai'`。
- `match_result.json.system_discarded_after_retry` 写入 `knowledge_discarded_groups`，`source = 'system'`。
- `report.json` 写入 `knowledge_reports`。

## 9. 清理规则

迁移成功后删除：

```text
knowledge-base/index.json
knowledge-base/folders/*/documents/*/blocks.json
knowledge-base/folders/*/documents/*/filtered_blocks.json
knowledge-base/folders/*/documents/*/candidate_items.json
knowledge-base/folders/*/documents/*/match_result.json
knowledge-base/folders/*/documents/*/report.json
knowledge-base/folders/*/documents/*/items.json
```

迁移成功后保留：

```text
knowledge-base/folders/*/documents/*/source.<ext>
knowledge-base/folders/*/documents/*/content.md
workspace/imported-images/knowledge-<documentId>-*/
logs/knowledge-base/<documentId>.jsonl
```

说明：

- `source.<ext>` 是用户上传资料副本，不能作为旧索引垃圾删除。
- `content.md` 是新版本仍需要按需读取的 Markdown 原文，不能迁入 SQLite 后删除。
- 下次是否弹窗只看旧 `index.json` 和迁移状态，不依赖旧结果 JSON 是否全部存在。

## 10. 失败处理

迁移失败：

- SQLite 事务回滚。
- 不删除任何旧文件。
- `knowledge_migration_meta.status = 'error'`，记录错误信息。
- 页面提示迁移失败，用户下次进入仍可重新尝试。

清理失败：

- SQLite 迁移结果保留。
- `knowledge_migration_meta.status = 'success'`，但 `cleanup_completed_at` 为空。
- `getMigrationStatus()` 返回 `cleanupPending: true`。
- 下次进入知识库时自动重试清理旧 JSON，不重复迁移，不再弹迁移确认框。

应用中途关闭：

- 如果 SQLite 事务未提交，旧 JSON 仍完整保留，下次继续提示迁移。
- 如果事务已提交但清理未完成，下次进入自动清理旧 JSON。
- 不允许在迁移中删除旧文件后再写 SQLite。

## 11. 任务体系边界

本轮知识库 SQLite 改造不强制接入 `taskService.cjs`。

原因：

- 当前 `taskService.activeTasks` 以 `type` 为 key，不适合直接支持同一任务类型按 `documentId` 并发。
- 知识库上传允许多文档并发准备和匹配，同一 `documentId` 需要互斥，不同文档可以并发。
- 直接接入会扩大任务系统重构范围。

目标保持：

- `knowledgeBaseService.cjs` 继续维护 `activePreparations` 和 `activeMatches`。
- 事件仍走 `knowledge-base:event`。
- 每个文档状态持续写入 SQLite。
- `list()` 或 `getMigrationStatus()` 后可将没有 active 任务的旧 running 状态恢复为 error。

后续如迁入 `taskService.cjs`，必须先支持同一 task type 的 `scope-exclusive(documentId)` 多实例管理。

## 12. SQLite 表设计概览

目标 v3 新增表：

| 表 | 用途 |
| --- | --- |
| `knowledge_migration_meta` | 旧知识库迁移状态和清理状态 |
| `knowledge_folders` | 文件夹列表 |
| `knowledge_documents` | 文档元数据、状态、路径、计数 |
| `knowledge_blocks` | 有效 block 和筛除 block |
| `knowledge_candidate_items` | 候选知识条目 |
| `knowledge_items` | 最终知识条目 |
| `knowledge_item_blocks` | 最终条目引用的来源 block |
| `knowledge_discarded_groups` | AI 舍弃和系统舍弃 block 组 |
| `knowledge_reports` | 分析报告 |

字段以 `sql/workspace_schema.sql` 为目标完整说明，运行时代码实现时必须同步 `sqliteDatabase.cjs` 的 migration。

## 13. 对外 API 兼容

保持现有 API：

- `knowledgeBase.list()`
- `knowledgeBase.createFolder(name)`
- `knowledgeBase.renameFolder(folderId, name)`
- `knowledgeBase.deleteFolder(folderId)`
- `knowledgeBase.deleteDocument(documentId)`
- `knowledgeBase.uploadDocuments(folderId)`
- `knowledgeBase.startMatching(documentId, batchSize)`
- `knowledgeBase.readMarkdown(documentId)`
- `knowledgeBase.readItems(documentId)`
- `knowledgeBase.readAnalysis(documentId)`
- `knowledgeBase.onEvent(callback)`

新增 API：

- `knowledgeBase.getMigrationStatus()`
- `knowledgeBase.migrateLegacy()`

返回结构必须保持兼容：

- `KnowledgeBaseIndex` 仍是 `{ folders, documents }`。
- `KnowledgeDocument` 字段和状态枚举保持现有前端可用字段。
- `KnowledgeItem.id` 仍为单文档内的 `K000001` 形式。
- 跨文档引用仍由服务层返回 `documentId::itemId`。

## 14. 验证标准

文档和 SQL 阶段：

```powershell
git diff --check -- client/doc/sqlite改造方案_知识库.md sql/workspace_schema.sql client/开发说明.md
```

代码实施阶段：

```powershell
cd client
node --check electron\services\sqliteDatabase.cjs
node --check electron\services\knowledgeBaseStore.cjs
node --check electron\services\knowledgeBaseService.cjs
node --check electron\ipc\knowledgeBaseIpc.cjs
node --check electron\preload.cjs
npm run build
```

Electron 运行时 smoke：

- 无旧数据时进入知识库，不弹迁移提示，列表为空或展示 SQLite 既有数据。
- 有旧 `index.json` 时进入知识库，弹出迁移确认文案。
- 用户取消迁移，不删除旧文件，下次进入继续提示。
- 用户确认迁移，迁移完成后列表展示旧文件夹和旧版已完成文档，非完成状态文档不展示。
- 迁移后可查看 Markdown、知识条目、分析调试页。
- 技术方案 Step03 可选择迁移后的知识库文档。
- 技术方案 Step04 可读取迁移后的知识条目正文。
- 迁移成功后旧 `index.json` 和旧结果 JSON 已删除，下次进入不再弹窗。
- 删除迁移后的知识库文档时，SQLite 记录、原始文件、Markdown 和对应 imported images 都被清理。
