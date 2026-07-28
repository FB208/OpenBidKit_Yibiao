import {
  MODEL_INFO_CACHE_INDEX_KEY,
  MODEL_INFO_CACHE_STATUS_KEY,
  MODEL_INFO_SOURCE_URL,
} from '../constants.js';

const CACHE_VERSION = 1;
const REASONING_EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// 将单个模型记录合并到按模型 ID 聚合的临时索引。
function mergeModelRecord(records, modelId, model) {
  const id = String(modelId || '').trim();
  if (!id) return;

  const record = records.get(id) || {
    effortSets: [],
    context: 0,
    output: 0,
  };
  const effortOption = Array.isArray(model?.reasoning_options)
    ? model.reasoning_options.find((option) => option?.type === 'effort')
    : null;
  const efforts = Array.isArray(effortOption?.values)
    ? [...new Set(effortOption.values
      .map((value) => typeof value === 'string' ? value.trim() : '')
      .filter(Boolean))]
    : [];
  if (efforts.length) record.effortSets.push(efforts);

  const context = Number(model?.limit?.context || 0);
  const output = Number(model?.limit?.output || 0);
  if (Number.isFinite(context) && context > record.context) record.context = Math.floor(context);
  if (Number.isFinite(output) && output > record.output) record.output = Math.floor(output);
  records.set(id, record);
}

// 按固定顺序整理思考强度，未知扩展值排在末尾。
function sortReasoningEfforts(efforts) {
  return [...efforts].sort((left, right) => {
    const leftIndex = REASONING_EFFORT_ORDER.indexOf(left);
    const rightIndex = REASONING_EFFORT_ORDER.indexOf(right);
    if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });
}

// 把 models.dev 完整目录转换为客户端查询所需的精简能力索引。
export function buildModelInfoIndex(catalog, sourceBytes, syncedAt = new Date().toISOString()) {
  const providers = catalog && typeof catalog === 'object' ? Object.values(catalog) : [];
  const records = new Map();
  let sourceModelCount = 0;

  providers.forEach((provider) => {
    if (!provider?.models || typeof provider.models !== 'object') return;
    Object.entries(provider.models).forEach(([modelKey, model]) => {
      sourceModelCount += 1;
      const modelId = String(model?.id || '').trim();
      mergeModelRecord(records, modelKey, model);
      if (modelId && modelId !== modelKey) mergeModelRecord(records, modelId, model);
    });
  });

  const models = {};
  let reasoningEffortModelCount = 0;
  for (const [modelId, record] of records.entries()) {
    const reasoningEfforts = record.effortSets.length
      ? sortReasoningEfforts(record.effortSets[0].filter((effort) => record.effortSets.every((values) => values.includes(effort))))
      : [];
    if (reasoningEfforts.length) reasoningEffortModelCount += 1;
    models[modelId] = {
      reasoningEfforts,
      context: record.context,
      output: record.output,
    };
  }

  return {
    version: CACHE_VERSION,
    sourceUrl: MODEL_INFO_SOURCE_URL,
    syncedAt,
    sourceBytes,
    providerCount: providers.length,
    sourceModelCount,
    indexedModelCount: Object.keys(models).length,
    reasoningEffortModelCount,
    models,
  };
}

// 读取 KV 中最近一次模型信息同步状态。
export async function readModelInfoCacheStatus(env) {
  if (!env.NOTICE_STORE) return null;
  const raw = await env.NOTICE_STORE.get(MODEL_INFO_CACHE_STATUS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// 读取指定模型的精简能力信息。
export async function readCachedModelInfo(env, modelName) {
  if (!env.NOTICE_STORE) return { available: false, index: null, model: null };
  const raw = await env.NOTICE_STORE.get(MODEL_INFO_CACHE_INDEX_KEY);
  if (!raw) return { available: false, index: null, model: null };
  try {
    const index = JSON.parse(raw);
    return {
      available: true,
      index,
      model: index?.models?.[String(modelName || '').trim()] || null,
    };
  } catch {
    return { available: false, index: null, model: null };
  }
}

// 从 models.dev 同步模型信息并原子替换客户端使用的精简索引。
export async function syncModelInfoCache(env, trigger = 'manual') {
  if (!env.NOTICE_STORE) throw new Error('NOTICE_STORE is not configured');

  const attemptedAt = new Date().toISOString();
  const previousStatus = await readModelInfoCacheStatus(env);
  try {
    const response = await fetch(MODEL_INFO_SOURCE_URL, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'OpenBidKit-Yibiao-Analytics',
      },
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`models.dev API ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }

    const sourceText = await response.text();
    const catalog = JSON.parse(sourceText);
    const index = buildModelInfoIndex(catalog, new TextEncoder().encode(sourceText).length, attemptedAt);
    const status = {
      status: 'success',
      trigger,
      lastAttemptAt: attemptedAt,
      lastSuccessAt: attemptedAt,
      error: '',
      sourceUrl: index.sourceUrl,
      sourceBytes: index.sourceBytes,
      providerCount: index.providerCount,
      sourceModelCount: index.sourceModelCount,
      indexedModelCount: index.indexedModelCount,
      reasoningEffortModelCount: index.reasoningEffortModelCount,
    };

    await env.NOTICE_STORE.put(MODEL_INFO_CACHE_INDEX_KEY, JSON.stringify(index));
    await env.NOTICE_STORE.put(MODEL_INFO_CACHE_STATUS_KEY, JSON.stringify(status));
    return { index, status };
  } catch (error) {
    const status = {
      ...(previousStatus || {}),
      status: 'failed',
      trigger,
      lastAttemptAt: attemptedAt,
      error: error?.message || String(error),
      sourceUrl: MODEL_INFO_SOURCE_URL,
    };
    await env.NOTICE_STORE.put(MODEL_INFO_CACHE_STATUS_KEY, JSON.stringify(status));
    throw error;
  }
}
