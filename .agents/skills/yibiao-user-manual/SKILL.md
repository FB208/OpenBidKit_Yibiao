---
name: yibiao-user-manual
description: 为易标投标工具箱按用户指定范围创建或更新 Markdown 使用说明、采集标注截图、基于正式 v2 Git 标签编写专业版本日志，并将目标文档与 issue-wiki 比较后按确认结果发布。用于用户要求更新使用说明、更新 v2 版本日志、全部更新、仅同步已有手册、只读检查，或明确调用 $yibiao-user-manual 的场景。
---

# 易标用户手册

只执行用户选定的文档任务。流程固定为“确定范围 → 生成或更新 → 服务器比较 → 确认后发布”，不得自行增加规划、测试、校验或兜底步骤。

## 一、确定任务

1. 用户未说明任务时，只询问本次要执行哪一项：
   - 更新指定功能或完整使用说明。
   - 更新 v2 版本日志。
   - 全部更新。
   - 仅同步已有本地文档。
   - 仅检查，不修改也不同步。
2. 用户只说“更新使用说明”时，询问指定功能还是完整使用说明。
3. 只有用户明确选择“全部更新”时，才同时更新完整使用说明和版本日志。
4. 用户明确要求“仅本地更新”时跳过服务器比较。
5. 不使用文件化规划或其他辅助规划 Skill，不创建计划文件。

## 二、固定执行约定

1. 所有 Shell 命令直接使用非沙箱执行（`sandbox_permissions: require_escalated`），不得先尝试沙箱，也不得加入沙箱失败重试流程。
2. 用户选择包含服务器比较或同步的任务，即视为授权读取本 Skill 的 `.env.local`、登录 issue-wiki 管理员 API 和读取远端数据；这些是核心步骤，不另行询问。
3. 远端预览只读取数据。只有预览产生实际写操作时，才向用户展示清单并询问是否发布；用户确认后直接执行，不再询问网络、登录或写入权限。
4. 只运行本 Skill 明确指定的脚本和必要的代码读取命令。运行时不执行开发阶段测试或校验，也不重复收集证据。
5. 脚本或环境出现与预期不同的错误时立即停止，告诉用户原始错误和继续所需操作。不得自动重试、改变参数、切换工具或设计临时兜底。
6. 只修改本次目标 Markdown 和截图，保留其他文件的已有修改。

## 三、使用说明任务

1. 完整阅读 [project-contract.md](references/project-contract.md) 和 `client/开发说明.md`；需要截图标注时再阅读 [annotation-format.md](references/annotation-format.md)。
2. 只检查目标功能的代码、发行版界面和已有业务数据。以发行版中用户实际可见行为为准，不写“正在开发中”、禁用或仅开发者可见的功能。
3. 流程页没有可用业务结果时停止，告诉用户需要先在发行版中完成哪些步骤；不得自行运行生成、解析、检查或其他耗时任务。
4. 使用简单中文说明入口、操作、等待结果和完成标志。局部任务只修改目标章节。
5. 需要截图时：
   - 使用 [capture-window.ps1](scripts/capture-window.ps1) 保存原图。
   - 使用 [annotate-screenshot.ps1](scripts/annotate-screenshot.ps1) 生成标注图。
   - 不使用生成式图片编辑重绘界面。

## 四、版本日志任务

1. 完整阅读 [changelog-standard.md](references/changelog-standard.md)，只处理 `使用说明/更新日志/v2版本更新日志.md`。
2. 运行一次：
   `python .agents/skills/yibiao-user-manual/scripts/changelog_tool.py inspect --json`
3. 没有新标签时报告“没有新的正式版本”，随后仍进入服务器比较。
4. 有新标签时，结合工具返回的提交和变更文件，按需阅读相关代码差异；提交标题只作为线索，排除重构、测试、CI 和其他用户不可感知变化。
5. 为最早缺失版本写成“新增、优化、修复、调整”中的必要栏目，然后使用一条 `insert --apply --json` 命令直接原子写入。工具会固定格式并补齐必要空行，不运行独立预览或专项校验。
6. 有多个缺失版本时按从早到晚逐个写入，每写入一个版本后重新运行 `inspect`。
7. 日志不存在、Git 历史不完整、基线标签缺失或版本关系不明确时停止，并告诉用户需要补充什么。

## 五、服务器比较与发布

1. 完整阅读 [sync-publication.md](references/sync-publication.md)。
2. 除“仅本地更新”和“仅检查”外，本地任务结束后始终运行服务器只读预览，即使本地没有新增内容。
3. 同步范围固定为本次目标：
   - 指定功能或版本日志：每个目标 Markdown 传入一个 `--scope`。
   - 完整使用说明但不含版本日志：传入 `--manual-only`。
   - 全部更新或用户明确要求完整目录：省略 `--scope`。
4. 运行：
   `python .agents/skills/yibiao-user-manual/scripts/sync_manual.py --json [--manual-only | --scope <目标Markdown>]`
5. `operations` 为空时直接报告服务器已一致。
6. `operations` 非空时展示完整清单和数量，只询问用户是否按该清单发布。
7. 用户确认后原样保留范围，并运行：
   `python .agents/skills/yibiao-user-manual/scripts/sync_manual.py --json [--manual-only | --scope <目标Markdown>] --apply --expected-plan-hash <plan_hash>`
8. 发布失败时停止并报告脚本错误，不自动重试或回滚。

## 六、交付

简要汇报：

- 本地创建或更新了哪些文档、版本和截图；没有新版本时明确说明。
- 服务器预览发现哪些创建、更新和图片上传操作。
- 用户确认发布后，汇报实际完成的远端操作。
- 遇到阻断时，只说明错误及用户如何继续。
