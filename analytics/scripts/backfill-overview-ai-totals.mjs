import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(__dirname, '../worker');
const projectName = 'yibiao-client';

// 从已有模型历史统计覆盖回填概览 AI 指标。
function main() {
  const updatedAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const sql = `
    INSERT INTO stats_totals (
      project_name,
      total_text_tokens,
      total_generated_images,
      updated_at
    ) VALUES (
      '${projectName}',
      COALESCE((
        SELECT SUM(total_tokens)
        FROM stats_models
        WHERE project_name = '${projectName}' AND request_type = 'text'
      ), 0),
      COALESCE((
        SELECT SUM(request_count)
        FROM stats_models
        WHERE project_name = '${projectName}' AND request_type = 'image'
      ), 0),
      '${updatedAt}'
    )
    ON CONFLICT(project_name) DO UPDATE SET
      total_text_tokens = excluded.total_text_tokens,
      total_generated_images = excluded.total_generated_images,
      updated_at = excluded.updated_at
  `;
  const result = spawnSync('npx', [
    'wrangler',
    'd1',
    'execute',
    'ANALYTICS_DB',
    '--remote',
    '--command',
    sql,
  ], {
    cwd: workerDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (result.status !== 0) {
    if (output) console.error(output);
    process.exit(result.status || 1);
  }

  if (output) console.log(output);
  console.log(`Overview AI totals backfilled for project: ${projectName}`);
}

main();
