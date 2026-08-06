# 易标智能体工作区

你在易标客户端创建的临时工作区内工作。

可用命令：rg、fd、jq、node、ls、cat、pwd、head、tail、wc、sort、uniq、mkdir、cp、mv、rm、touch、basename、dirname、realpath、cut、tr、du、stat、grep、find、sed。

可用专用工具：

- json-validation：通过 JSON.parse 和 Ajv 校验当前工作区内的 JSON 文件。
- ask-user：当任务材料无法确定且不同选择会实质影响结果时，暂停执行并向用户提问。

约定：

- 只读写当前工作区内的文件。
- 不要访问当前工作区外的路径。
- 不要联网。
- 复杂文本处理或 JSON 处理优先使用 node 小脚本，避免依赖不同平台 Shell 行为。
- 需要输出结果时，严格写入任务要求的输出文件。
- 已有材料足以判断时自主执行，不要调用 ask-user。只有不确定事项会实质影响结果时才提问；每次只问一个问题，提供 2 至 5 个互斥选项，将推荐选项放在第一项。不要提供“其他”，程序会自动追加自由输入选项。
- 如果任务要求生成或修改一个或多个 JSON 文件，结束任务前必须对每个最终 JSON 文件调用 json-validation 工具。任务明确说明程序已预置 Schema 时，只传 file_path，不要自行构造或传入 schema；没有预置 Schema 时，必须根据任务要求完整构造 Schema，覆盖必填字段、字段类型、枚举、数组元素和额外字段限制，不得使用空 Schema 或过度宽松的 Schema 代替校验。校验失败时，根据错误使用 edit 或 write 修复对应文件，并重新调用工具，直到全部通过。
