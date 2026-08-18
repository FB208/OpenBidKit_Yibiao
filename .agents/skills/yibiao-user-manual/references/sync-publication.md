# 使用说明服务器发布规范

使用 [sync_manual.py](../scripts/sync_manual.py) 比较并发布本次目标 Markdown 及其引用图片。

## 配置

- 脚本固定读取 `.agents/skills/yibiao-user-manual/.env.local`，格式参考同目录 `.env.example`。
- 必填项为 API 地址、管理员账号和密码；作者可选。
- 不读取其他密钥文件，不输出密码、令牌或请求头。
- 调用同步任务即授权脚本读取该配置、登录管理员 API 和读取远端数据，不另行询问。

## 只读预览

从仓库根目录直接使用非沙箱执行：

```powershell
python .agents/skills/yibiao-user-manual/scripts/sync_manual.py --json `
  --scope '配置/01-配置文本模型.md' `
  --scope '使用/05-废标项检查.md'
```

指定文档时重复传入相对 `使用说明/` 的 `--scope`；完整使用说明但不含版本日志时传入 `--manual-only`；只有“全部更新”或完整目录同步才省略两者。

预览允许登录和读取，但不会上传图片、创建文件夹或写入文档。JSON 中：

- `operations`：完整远端写操作清单。
- `summary`：创建、更新、上传、复用和跳过数量。
- `plan_hash`：用户确认后发布所需的计划指纹。

没有写操作时直接结束，不询问确认。

## 确认后发布

展示 `operations` 并取得用户对该变更清单的确认，然后直接运行：

```powershell
python .agents/skills/yibiao-user-manual/scripts/sync_manual.py --json `
  --scope '配置/01-配置文本模型.md' `
  --scope '使用/05-废标项检查.md' `
  --apply `
  --expected-plan-hash '<plan_hash>'
```

发布前脚本会重新读取本地文件和远端数据。计划变化时停止并要求用户重新确认新清单。

## 固定映射

- `使用说明/` 子目录映射为网站同名文件夹；版本日志固定映射到网站“更新日志”文件夹。
- 按文件夹路径和完整文件名匹配文档。
- 只上传 Markdown 实际引用的 JPG、JPEG、PNG、GIF 或 WebP。
- 不删除服务器文档、文件夹、图片、评论或点赞。
- 发布失败时报告脚本错误和可能已完成的操作，不重试、不回滚。
- 配置、网络、登录或远端数据不符合预期时立即停止，告诉用户应检查的配置或服务器状态。
