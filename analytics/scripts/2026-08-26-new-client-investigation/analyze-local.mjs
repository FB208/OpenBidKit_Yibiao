import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataRoot = resolve(__dirname, 'data');

// 读取 UTF-8 JSON 文件。
function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

// 读取 UTF-8 JSONL 文件。
function readJsonLines(filePath) {
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// 选择最新完成的下载目录，跳过前序失败产生的部分目录。
function findLatestCompletedRun() {
  const runs = readdirSync(dataRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(dataRoot, entry.name))
    .filter((runPath) => existsSync(resolve(runPath, 'manifest.json')))
    .filter((runPath) => readJson(resolve(runPath, 'manifest.json')).status === 'completed')
    .sort();
  const runPath = runs.at(-1);
  if (!runPath) throw new Error('No completed download run found');
  return runPath;
}

// 判断模型接口域名是否只指向客户端本机。
function isLocalEndpoint(host) {
  const value = String(host || '').trim().toLowerCase();
  return value === '127.0.0.1' || value === 'localhost' || value === '::1' || value.endsWith('.localhost');
}

// 将客户端集合中的数值字段求和。
function sumClients(clients, field) {
  return clients.reduce((sum, client) => sum + Number(client[field] || 0), 0);
}

// 统计字符串维度对应的客户端数和 Token 数。
function dimensionSummary(clients, field) {
  const values = new Map();
  for (const client of clients) {
    for (const value of client[field] || []) {
      if (!values.has(value)) values.set(value, { value, clientIds: new Set(), totalTokens: 0 });
      const item = values.get(value);
      item.clientIds.add(client.clientId);
      item.totalTokens += Number(client.totalTokens || 0);
    }
  }
  return [...values.values()]
    .map((item) => ({ value: item.value, clientCount: item.clientIds.size, totalTokens: item.totalTokens }))
    .sort((left, right) => right.clientCount - left.clientCount || right.totalTokens - left.totalTokens || left.value.localeCompare(right.value));
}

// 按首次记录小时统计新增客户端数量。
function hourlySummary(clients) {
  const counts = new Map();
  for (const client of clients) {
    const hour = String(client.firstSeenAt || '').slice(0, 13);
    if (!hour) continue;
    counts.set(hour, (counts.get(hour) || 0) + 1);
  }
  return [...counts.entries()].map(([hour, clientCount]) => ({ hour, clientCount })).sort((left, right) => left.hour.localeCompare(right.hour));
}

// 生成同 IP 与外部 AI 请求交叉分析结果。
function buildAnalysis(clients, ips) {
  const clientById = new Map(clients.map((client) => [client.clientId, client]));
  const sharedIpSet = new Set(ips.filter((item) => item.cohortClientCount > 1).map((item) => item.ip));
  const priorOverlapIpSet = new Set(ips.filter((item) => item.priorD1ClientCount > 0 || item.priorAeClientCount > 0).map((item) => item.ip));

  const hasExternalTokenAi = (client) => Number(client.totalTokens || 0) > 0
    && (client.endpointHosts || []).some((host) => !isLocalEndpoint(host));
  const hasLocalOnlyTokenAi = (client) => Number(client.totalTokens || 0) > 0
    && (client.endpointHosts || []).length > 0
    && (client.endpointHosts || []).every(isLocalEndpoint);
  const onSharedIp = (client) => (client.ips || []).some((ip) => sharedIpSet.has(ip));
  const onPriorOverlapIp = (client) => (client.ips || []).some((ip) => priorOverlapIpSet.has(ip));

  const externalTokenClients = clients.filter(hasExternalTokenAi);
  const localOnlyTokenClients = clients.filter(hasLocalOnlyTokenAi);
  const sharedIpClients = clients.filter(onSharedIp);
  const priorOverlapClients = clients.filter(onPriorOverlapIp);
  const sharedWithoutExternalAi = clients.filter((client) => onSharedIp(client) && !hasExternalTokenAi(client));
  const priorOverlapWithoutExternalAi = clients.filter((client) => onPriorOverlapIp(client) && !hasExternalTokenAi(client));

  const topIps = ips.slice(0, 20).map((item) => {
    const ipClients = item.cohortClientIds.map((clientId) => clientById.get(clientId)).filter(Boolean);
    return {
      ip: item.ip,
      cohortClientCount: ipClients.length,
      clientsWithAnyAiRequest: ipClients.filter((client) => Number(client.aiRequestCount || 0) > 0).length,
      clientsWithTokenUsage: ipClients.filter((client) => Number(client.totalTokens || 0) > 0).length,
      clientsWithExternalTokenAi: ipClients.filter(hasExternalTokenAi).length,
      clientsWithLocalOnlyTokenAi: ipClients.filter(hasLocalOnlyTokenAi).length,
      clientsWithoutAiRequest: ipClients.filter((client) => Number(client.aiRequestCount || 0) === 0).length,
      weightedAiRequestCount: sumClients(ipClients, 'aiRequestCount'),
      weightedTotalTokens: sumClients(ipClients, 'totalTokens'),
      priorD1ClientCount: item.priorD1ClientCount,
      priorAeClientCount: item.priorAeClientCount,
    };
  });

  const firstTwoIpClientIds = ips.slice(0, 2).map((item) => new Set(item.cohortClientIds));
  const firstTwoUnion = new Set(firstTwoIpClientIds.flatMap((set) => [...set]));
  const firstTwoIntersection = firstTwoIpClientIds.length === 2
    ? [...firstTwoIpClientIds[0]].filter((clientId) => firstTwoIpClientIds[1].has(clientId))
    : [];
  const firstTwoClients = [...firstTwoUnion].map((clientId) => clientById.get(clientId)).filter(Boolean);

  return {
    cohortClients: clients.length,
    clientsWithAnyAiRequest: clients.filter((client) => Number(client.aiRequestCount || 0) > 0).length,
    clientsWithAnyTokenUsage: clients.filter((client) => Number(client.totalTokens || 0) > 0).length,
    clientsWithExternalTokenAi: externalTokenClients.length,
    externalTokenTotal: sumClients(externalTokenClients, 'totalTokens'),
    clientsWithLocalOnlyTokenAi: localOnlyTokenClients.length,
    localOnlyTokenTotal: sumClients(localOnlyTokenClients, 'totalTokens'),
    clientsWithZeroTokenAiOnly: clients.filter((client) => Number(client.aiRequestCount || 0) > 0 && Number(client.totalTokens || 0) === 0).length,
    clientsWithoutAiRequest: clients.filter((client) => Number(client.aiRequestCount || 0) === 0).length,
    sharedIpClients: sharedIpClients.length,
    sharedIpClientsWithoutExternalTokenAi: sharedWithoutExternalAi.length,
    priorOverlapClients: priorOverlapClients.length,
    priorOverlapClientsWithoutExternalTokenAi: priorOverlapWithoutExternalAi.length,
    topTwoIps: ips.slice(0, 2).map((item) => item.ip),
    topTwoIpClientUnion: firstTwoClients.length,
    topTwoIpClientIntersection: firstTwoIntersection.length,
    topTwoIpClientsWithExternalTokenAi: firstTwoClients.filter(hasExternalTokenAi).length,
    topTwoIpClientsWithLocalOnlyTokenAi: firstTwoClients.filter(hasLocalOnlyTokenAi).length,
    topTwoIpClientsWithZeroTokenAiOnly: firstTwoClients.filter((client) => Number(client.aiRequestCount || 0) > 0 && Number(client.totalTokens || 0) === 0).length,
    topTwoIpClientsWithoutAiRequest: firstTwoClients.filter((client) => Number(client.aiRequestCount || 0) === 0).length,
    endpointHosts: dimensionSummary(clients, 'endpointHosts'),
    providers: dimensionSummary(clients, 'providers'),
    models: dimensionSummary(clients, 'models').slice(0, 50),
    firstSeenHourly: hourlySummary(clients),
    topIps,
  };
}

// 执行本地分析并写回下载目录。
function main() {
  const runPath = findLatestCompletedRun();
  const clients = readJsonLines(resolve(runPath, 'new-client-summary.jsonl'));
  const ips = readJsonLines(resolve(runPath, 'ip-summary.jsonl'));
  const analysis = buildAnalysis(clients, ips);
  writeFileSync(resolve(runPath, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
  const manifestPath = resolve(runPath, 'manifest.json');
  const manifest = readJson(manifestPath);
  manifest.analyzedAt = new Date().toISOString();
  manifest.files['analysis.json'] = 1;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Analyzed: ${runPath}`);
  console.log(`Cohort=${analysis.cohortClients}, external-token-AI=${analysis.clientsWithExternalTokenAi}, shared-IP-without-external-AI=${analysis.sharedIpClientsWithoutExternalTokenAi}`);
}

main();
