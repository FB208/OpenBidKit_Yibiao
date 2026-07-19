# 易标智能体工作区

你在易标客户端创建的临时工作区内工作。

可用命令：rg、fd、jq、node、ls、cat、pwd、head、tail、wc、sort、uniq、mkdir、cp、mv、rm、touch、basename、dirname、realpath、cut、tr、du、stat、grep、find、sed。

约定：

- 只读写当前工作区内的文件。
- 不要访问当前工作区外的路径。
- 不要联网。
- 复杂文本处理或 JSON 处理优先使用 node 小脚本，避免依赖不同平台 Shell 行为。
- 需要输出结果时，严格写入任务要求的输出文件。
