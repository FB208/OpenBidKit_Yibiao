import {
  MODEL_INFO_CACHE_INDEX_KEY,
  MODEL_INFO_CACHE_OVERRIDES_KEY,
  MODEL_INFO_CACHE_STATUS_KEY,
  MODEL_INFO_SOURCE_URL,
} from '../constants.js';

const CACHE_VERSION = 3;
const REASONING_EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MODALITY_ORDER = ['text', 'image', 'pdf', 'audio', 'video'];
const CAPABILITY_STATUSES = new Set(['supported', 'unsupported', 'mixed', 'unknown']);
const DEFAULT_CONCURRENCY_LIMIT = 10;
const DEFAULT_REQUEST_MODE = 'stream';

// 清理并稳定排序模型输入、输出模态。
function normalizeModalities(values) {
  const modalities = Array.isArray(values)
    ? [...new Set(values.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))]
    : [];
  return modalities.sort((left, right) => {
    const leftIndex = MODALITY_ORDER.indexOf(left);
    const rightIndex = MODALITY_ORDER.indexOf(right);
    if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });
}

// 根据图片输入和文本输出能力判断单个来源是否支持图片理解。
function getImageInputCapability(inputModalities, outputModalities) {
  if (!inputModalities.length || !outputModalities.length) return null;
  return inputModalities.includes('image') && outputModalities.includes('text');
}

// 汇总同名模型在不同来源中的布尔能力支持情况。
function resolveCapabilityStatus(capabilities) {
  if (!capabilities.length || capabilities.some((value) => value === null)) return 'unknown';
  if (capabilities.every(Boolean)) return 'supported';
  if (capabilities.every((value) => !value)) return 'unsupported';
  return 'mixed';
}

// 将单个模型记录合并到按模型 ID 聚合的临时索引。
function mergeModelRecord(records, modelId, model) {
  const id = String(modelId || '').trim();
  if (!id) return;

  const record = records.get(id) || {
    effortSets: [],
    context: 0,
    output: 0,
    inputModalities: [],
    outputModalities: [],
    imageInputCapabilities: [],
    temperatureCapabilities: [],
    sourceCount: 0,
  };
  record.sourceCount += 1;
  const effortOption = Array.isArray(model?.reasoning_options)
    ? model.reasoning_options.find((option) => option?.type === 'effort')
    : null;
  const efforts = Array.isArray(effortOption?.values)
    ? [...new Set(effortOption.values
      .map((value) => typeof value === 'string' ? value.trim() : '')
      .filter(Boolean))]
    : [];
  if (efforts.length) record.effortSets.push(efforts);

  const hasInputModalities = Array.isArray(model?.modalities?.input);
  const hasOutputModalities = Array.isArray(model?.modalities?.output);
  const inputModalities = normalizeModalities(model?.modalities?.input);
  const outputModalities = normalizeModalities(model?.modalities?.output);
  record.inputModalities = normalizeModalities([...record.inputModalities, ...inputModalities]);
  record.outputModalities = normalizeModalities([...record.outputModalities, ...outputModalities]);
  record.imageInputCapabilities.push(hasInputModalities && hasOutputModalities
    ? getImageInputCapability(inputModalities, outputModalities)
    : null);
  record.temperatureCapabilities.push(typeof model?.temperature === 'boolean' ? model.temperature : null);

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
  const inputModalities = normalizeModalities(model?.inputModalities);
  const outputModalities = normalizeModalities(model?.outputModalities);
  const inferredImageInputStatus = getImageInputCapability(inputModalities, outputModalities);
  return {
    reasoningEfforts: Array.isArray(model?.reasoningEfforts)
      ? [...new Set(model.reasoningEfforts.map((value) => String(value || '').trim()).filter(Boolean))]
      : [],
    context: Math.max(0, Math.floor(Number(model?.context) || 0)),
    output: Math.max(0, Math.floor(Number(model?.output) || 0)),
    inputModalities,
    outputModalities,
    imageInputStatus: CAPABILITY_STATUSES.has(model?.imageInputStatus)
      ? model.imageInputStatus
      : inferredImageInputStatus === null ? 'unknown' : inferredImageInputStatus ? 'supported' : 'unsupported',
    temperatureStatus: CAPABILITY_STATUSES.has(model?.temperatureStatus) ? model.temperatureStatus : 'unknown',
    concurrencyLimit: Number.isFinite(Number(model?.concurrencyLimit)) && Number(model.concurrencyLimit) > 0
      ? Math.floor(Number(model.concurrencyLimit))
      : DEFAULT_CONCURRENCY_LIMIT,
    requestMode: model?.requestMode === 'normal' ? 'normal' : DEFAULT_REQUEST_MODE,
    sourceCount: Math.max(0, Math.floor(Number(model?.sourceCount) || 0)),
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
  let imageInputModelCount = 0;
  let mixedImageInputModelCount = 0;
  let temperatureModelCount = 0;
  let mixedTemperatureModelCount = 0;
  for (const [modelId, record] of records.entries()) {
    const reasoningEfforts = record.effortSets.length
      ? sortReasoningEfforts(record.effortSets[0].filter((effort) => record.effortSets.every((values) => values.includes(effort))))
      : [];
    if (reasoningEfforts.length) reasoningEffortModelCount += 1;
    const imageInputStatus = resolveCapabilityStatus(record.imageInputCapabilities);
    const temperatureStatus = resolveCapabilityStatus(record.temperatureCapabilities);
    if (imageInputStatus === 'supported') imageInputModelCount += 1;
    if (imageInputStatus === 'mixed') mixedImageInputModelCount += 1;
    if (temperatureStatus === 'supported') temperatureModelCount += 1;
    if (temperatureStatus === 'mixed') mixedTemperatureModelCount += 1;
    models[modelId] = {
      reasoningEfforts,
      context: record.context,
      output: record.output,
      inputModalities: record.inputModalities,
      outputModalities: record.outputModalities,
      imageInputStatus,
      temperatureStatus,
      concurrencyLimit: DEFAULT_CONCURRENCY_LIMIT,
      requestMode: DEFAULT_REQUEST_MODE,
      sourceCount: record.sourceCount,
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
    imageInputModelCount,
    mixedImageInputModelCount,
    temperatureModelCount,
    mixedTemperatureModelCount,
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
    model: override || sourceModel ? normalizeModelInfoRecord(override || sourceModel) : null,
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
      imageInputModelCount: index.imageInputModelCount,
      mixedImageInputModelCount: index.mixedImageInputModelCount,
      temperatureModelCount: index.temperatureModelCount,
      mixedTemperatureModelCount: index.mixedTemperatureModelCount,
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
