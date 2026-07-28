import {
  MODEL_INFO_CACHE_INDEX_KEY,
  MODEL_INFO_CACHE_OVERRIDES_KEY,
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

// 统一模型能力记录格式，供自动索引和人工覆盖共同使用。
function normalizeModelInfoRecord(model) {
  return {
    reasoningEfforts: Array.isArray(model?.reasoningEfforts)
      ? [...new Set(model.reasoningEfforts.map((value) => String(value || '').trim()).filter(Boolean))]
      : [],
    context: Math.max(0, Math.floor(Number(model?.context) || 0)),
    output: Math.max(0, Math.floor(Number(model?.output) || 0)),
  };
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

// 读取自动同步生成的模型能力索引。
export async function readModelInfoCacheIndex(env) {
  if (!env.NOTICE_STORE) return null;
  const raw = await env.NOTICE_STORE.get(MODEL_INFO_CACHE_INDEX_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// 读取管理员人工覆盖记录；该数据不会被自动同步任务修改。
export async function readModelInfoOverrides(env) {
  if (!env.NOTICE_STORE) return { version: CACHE_VERSION, models: {} };
  const raw = await env.NOTICE_STORE.get(MODEL_INFO_CACHE_OVERRIDES_KEY);
  if (!raw) return { version: CACHE_VERSION, models: {} };
  try {
    const overrides = JSON.parse(raw);
    return {
      version: CACHE_VERSION,
      models: overrides?.models && typeof overrides.models === 'object' ? overrides.models : {},
    };
  } catch {
    return { version: CACHE_VERSION, models: {} };
  }
}

// 读取指定模型的精简能力信息。
export async function readCachedModelInfo(env, modelName) {
  if (!env.NOTICE_STORE) return { available: false, index: null, model: null };
  const normalizedName = String(modelName || '').trim();
  const [index, overrides] = await Promise.all([
    readModelInfoCacheIndex(env),
    readModelInfoOverrides(env),
  ]);
  const override = overrides.models[normalizedName] || null;
  const sourceModel = index?.models?.[normalizedName] || null;
  return {
    available: Boolean(index || override),
    index,
    model: override ? normalizeModelInfoRecord(override) : sourceModel,
  };
}

// 返回管理端分页表格使用的最终索引，人工覆盖记录优先于自动同步值。
export async function listAdminModelInfo(env, options = {}) {
  const [index, overrides] = await Promise.all([
    readModelInfoCacheIndex(env),
    readModelInfoOverrides(env),
  ]);
  const sourceModels = index?.models && typeof index.models === 'object' ? index.models : {};
  const overrideModels = overrides.models;
  const query = String(options.query || '').trim().toLocaleLowerCase();
  const overriddenOnly = options.scope === 'overridden';
  const pageSize = Math.max(1, Math.min(100, Math.floor(Number(options.pageSize) || 50)));
  const requestedPage = Math.max(1, Math.floor(Number(options.page) || 1));

  const modelNames = [...new Set([...Object.keys(sourceModels), ...Object.keys(overrideModels)])]
    .filter((modelName) => !query || modelName.toLocaleLowerCase().includes(query))
    .filter((modelName) => !overriddenOnly || Boolean(overrideModels[modelName]))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' }));
  const total = modelNames.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const models = modelNames.slice((page - 1) * pageSize, page * pageSize).map((modelName) => {
    const override = overrideModels[modelName] || null;
    const model = normalizeModelInfoRecord(override || sourceModels[modelName]);
    return {
      modelName,
      ...model,
      overridden: Boolean(override),
      updatedAt: override?.updatedAt || index?.syncedAt || '',
    };
  });

  return {
    available: Boolean(index),
    models,
    total,
    page,
    pageSize,
    overrideCount: Object.keys(overrideModels).length,
  };
}

// 保存一条完整的管理员人工覆盖记录。
export async function saveModelInfoOverride(env, modelName, model) {
  const overrides = await readModelInfoOverrides(env);
  const record = normalizeModelInfoRecord(model);
  overrides.models[modelName] = {
    ...record,
    reasoningEfforts: sortReasoningEfforts(record.reasoningEfforts),
    updatedAt: new Date().toISOString(),
  };
  await env.NOTICE_STORE.put(MODEL_INFO_CACHE_OVERRIDES_KEY, JSON.stringify(overrides));
  return overrides.models[modelName];
}

// 删除人工覆盖，使该模型立即恢复最近一次自动同步值。
export async function deleteModelInfoOverride(env, modelName) {
  const overrides = await readModelInfoOverrides(env);
  const existed = Boolean(overrides.models[modelName]);
  if (!existed) return false;
  delete overrides.models[modelName];
  if (Object.keys(overrides.models).length) {
    await env.NOTICE_STORE.put(MODEL_INFO_CACHE_OVERRIDES_KEY, JSON.stringify(overrides));
  } else {
    await env.NOTICE_STORE.delete(MODEL_INFO_CACHE_OVERRIDES_KEY);
  }
  return true;
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
