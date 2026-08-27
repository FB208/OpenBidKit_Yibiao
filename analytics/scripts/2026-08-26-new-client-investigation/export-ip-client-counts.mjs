import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataRoot = resolve(__dirname, 'data');

// 选择最新完成的下载目录。
function findLatestCompletedRun() {
  const runs = readdirSync(dataRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(dataRoot, entry.name))
    .filter((runPath) => existsSync(resolve(runPath, 'manifest.json')))
    .filter((runPath) => JSON.parse(readFileSync(resolve(runPath, 'manifest.json'), 'utf8')).status === 'completed')
    .sort();
  const runPath = runs.at(-1);
  if (!runPath) throw new Error('No completed download run found');
  return runPath;
}

// 读取新增客户端 JSONL 数据。
function readJsonLines(filePath) {
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// 按客户端首次记录 IP 汇总并导出 Excel 可读的 CSV。
function main() {
  const runPath = findLatestCompletedRun();
  const clients = readJsonLines(resolve(runPath, 'd1-new-clients.jsonl'));
  const counts = new Map();
  for (const client of clients) {
    const ip = String(client.lastAccessIp || '').trim() || '未记录';
    counts.set(ip, (counts.get(ip) || 0) + 1);
  }
  const rows = [...counts.entries()]
    .map(([ip, clientCount]) => ({ ip, clientCount, percentage: clientCount / clients.length }))
    .sort((left, right) => right.clientCount - left.clientCount || left.ip.localeCompare(right.ip));
  const csv = [
    'IP地址,客户端数,占401个新增客户端比例',
    ...rows.map((row) => `${row.ip},${row.clientCount},${(row.percentage * 100).toFixed(2)}%`),
    `合计,${clients.length},100.00%`,
  ].join('\r\n');
  const outputPath = resolve(runPath, '新增客户端IP统计.csv');
  writeFileSync(outputPath, `\uFEFF${csv}\r\n`, 'utf8');
  console.log(`Exported: ${outputPath}`);
  console.log(`IPs=${rows.length}, clients=${clients.length}`);
}

main();
