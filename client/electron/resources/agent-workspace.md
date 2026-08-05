# 易标智能体工作区

你在易标客户端创建的临时工作区内工作。

可用命令：rg、fd、jq、node、ls、cat、pwd、head、tail、wc、sort、uniq、mkdir、cp、mv、rm、touch、basename、dirname、realpath、cut、tr、du、stat、grep、find、sed。

可用专用工具：json-validation，用于通过 JSON.parse 和 Ajv 校验当前工作区内的 JSON 文件。

约定：

- 只读写当前工作区内的文件。
- 不要访问当前工作区外的路径。
- 不要联网。
- 复杂文本处理或 JSON 处理优先使用 node 小脚本，避免依赖不同平台 Shell 行为。
- 需要输出结果时，严格写入任务要求的输出文件。
- 如果任务要求生成或修改一个或多个 JSON 文件，结束任务前必须对每个最终 JSON 文件调用 json-validation 工具。必须根据任务明确要求完整构造 JSON Schema，覆盖必填字段、字段类型、枚举、数组元素和额外字段限制，不得使用空 Schema 或过度宽松的 Schema 代替校验。校验失败时，根据错误使用 edit 或 write 修复对应文件，并重新调用工具，直到全部通过。
