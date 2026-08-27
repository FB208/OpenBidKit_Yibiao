const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { safeStorage } = require('electron');
const { getDonationStateFilePath } = require('../utils/paths.cjs');

const ISSUE_WIKI_API_BASE = 'https://wiki.agnet.top/api';
const STATE_VERSION = 2;
const RUNTIME_CHECK_INTERVAL_MS = 60_000;
const RUNTIME_PERSIST_INTERVAL_MS = 5 * 60_000;
const RUNTIME_PROMPT_INTERVAL_MS = 5 * 60 * 60_000;
const EXPORT_PROMPT_INTERVAL = 5;
const DONATION_MARKER_TEXT = 'yibiao-donation-paid-v1';

const defaultState = {
  version: STATE_VERSION,
  accumulatedRuntimeMs: 0,
  wordExportClicks: 0,
  processedRuntimeBucket: 0,
  processedExportBucket: 0,
  donationMarker: '',
  pendingOrders: [],
};

/** 读取并规范化本地打赏提示状态。 */
function readState(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return {
      ...defaultState,
      accumulatedRuntimeMs: Math.max(0, Number(value.accumulatedRuntimeMs) || 0),
      wordExportClicks: Math.max(0, Math.floor(Number(value.wordExportClicks) || 0)),
      processedRuntimeBucket: Math.max(0, Math.floor(Number(value.processedRuntimeBucket) || 0)),
      processedExportBucket: Math.max(0, Math.floor(Number(value.processedExportBucket) || 0)),
      donationMarker: String(value.donationMarker || ''),
      pendingOrders: Array.isArray(value.pendingOrders)
        ? value.pendingOrders
          .map((item) => ({
            merchantOrderNo: String(item?.merchantOrderNo || ''),
            expiresAt: Math.max(0, Number(item?.expiresAt) || 0),
          }))
          .filter((item) => item.merchantOrderNo)
        : [],
    };
  } catch {
    return { ...defaultState };
  }
}

/** 使用临时文件原子写入 UTF-8 JSON，避免退出期间留下半截状态。 */
function writeState(filePath, state) {
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    try { fs.rmSync(tempFile, { force: true }); } catch {}
    throw error;
  }
}

/** 请求 issue-wiki 的公开打赏接口并统一转换错误信息。 */
async function requestDonationApi(path, options = {}) {
  let response;
  try {
    response = await fetch(`${ISSUE_WIKI_API_BASE}${path}`, {
      ...options,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`无法连接打赏服务：${error?.message || String(error)}`);
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const detail = Array.isArray(data?.detail)
      ? data.detail.map((item) => item?.msg).filter(Boolean).join('；')
      : data?.detail;
    const requestError = new Error(detail || text || `打赏服务请求失败：HTTP ${response.status}`);
    requestError.statusCode = response.status;
    throw requestError;
  }
  if (!data) {
    throw new Error('打赏服务返回的数据格式不正确');
  }
  return data;
}

/** 提供远程支付、本地累计计数和自动提示状态。 */
function createDonationService({ app, onPrompt, onPaid }) {
  const stateFile = getDonationStateFilePath(app);
  const state = readState(stateFile);
  let runtimeCheckpoint = performance.now();
  let lastPersistedAt = runtimeCheckpoint;
  let pendingOrderCheckRunning = false;
  let donated = false;
  let closed = false;
  const orderStatusRequests = new Map();

  try {
    donated = Boolean(state.donationMarker)
      && safeStorage.isEncryptionAvailable()
      && safeStorage.decryptString(Buffer.from(state.donationMarker, 'base64')) === DONATION_MARKER_TEXT;
  } catch {
    donated = false;
  }

  /** 将本次进程运行增量合并到累计时长。 */
  const checkpointRuntime = () => {
    const now = performance.now();
    state.accumulatedRuntimeMs += Math.max(0, Math.floor(now - runtimeCheckpoint));
    runtimeCheckpoint = now;
    return now;
  };

  /** 保存完整状态，并同步本次落盘时间。 */
  const persist = () => {
    writeState(stateFile, state);
    lastPersistedAt = performance.now();
  };

  const tryPersist = (context) => {
    try {
      persist();
    } catch (error) {
      console.warn(`[donation] ${context}失败`, error?.message || String(error));
    }
  };

  const summary = (reason) => ({
    reason,
    accumulatedRuntimeMs: state.accumulatedRuntimeMs,
    wordExportClicks: state.wordExportClicks,
  });

  /** 记录跨过的时长档位；已打赏时只累计，不主动提示。 */
  const processRuntimePrompt = () => {
    const bucket = Math.floor(state.accumulatedRuntimeMs / RUNTIME_PROMPT_INTERVAL_MS);
    if (bucket <= state.processedRuntimeBucket) return false;
    state.processedRuntimeBucket = bucket;
    if (!donated) onPrompt?.(summary('runtime'));
    return true;
  };

  /** 写入加密成功标记，并停止当前待支付订单恢复。 */
  const markDonated = () => {
    const firstDonation = !donated;
    if (!donated) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('系统安全存储当前不可用，无法保存打赏状态');
      }
      state.donationMarker = safeStorage.encryptString(DONATION_MARKER_TEXT).toString('base64');
      donated = true;
    }
    state.pendingOrders = [];
    checkpointRuntime();
    persist();
    if (firstDonation) onPaid?.();
  };

  const removePendingOrder = (merchantOrderNo) => {
    const nextOrders = state.pendingOrders.filter((item) => item.merchantOrderNo !== merchantOrderNo);
    if (nextOrders.length === state.pendingOrders.length) return false;
    state.pendingOrders = nextOrders;
    return true;
  };

  /** 合并同一订单的 Renderer 与后台查询，并根据终态更新本地状态。 */
  const requestOrderStatus = (merchantOrderNo, path, options) => {
    const activeRequest = orderStatusRequests.get(merchantOrderNo);
    if (activeRequest) return activeRequest;

    const request = requestDonationApi(path, options)
      .then((order) => {
        if (order.status === 'paid') {
          markDonated();
        } else if (['failed', 'closed'].includes(order.status) && removePendingOrder(merchantOrderNo)) {
          tryPersist('清理失效订单状态');
        }
        return order;
      })
      .catch((error) => {
        if (error?.statusCode === 404) {
          if (removePendingOrder(merchantOrderNo)) tryPersist('清理不存在的订单');
          return {
            merchant_order_no: merchantOrderNo,
            amount: '0',
            channel: 'xorpay',
            status: 'closed',
            paid_at: null,
          };
        }
        throw error;
      })
      .finally(() => {
        if (orderStatusRequests.get(merchantOrderNo) === request) {
          orderStatusRequests.delete(merchantOrderNo);
        }
      });
    orderStatusRequests.set(merchantOrderNo, request);
    return request;
  };

  const getOrderStatus = (merchantOrderNo) => requestOrderStatus(
    merchantOrderNo,
    `/payments/orders/${encodeURIComponent(merchantOrderNo)}`,
  );

  const finalizeOrderStatus = (merchantOrderNo) => requestOrderStatus(
    merchantOrderNo,
    `/payments/orders/${encodeURIComponent(merchantOrderNo)}/finalize`,
    { method: 'POST' },
  );

  /** 后台恢复所有未确认订单，到期后改由渠道查询最终确认。 */
  const checkPendingOrder = async () => {
    if (state.pendingOrders.length === 0 || pendingOrderCheckRunning) return;
    pendingOrderCheckRunning = true;
    try {
      for (const pendingOrder of [...state.pendingOrders]) {
        try {
          if (pendingOrder.expiresAt > 0 && Date.now() >= pendingOrder.expiresAt) {
            await finalizeOrderStatus(pendingOrder.merchantOrderNo);
          } else {
            await getOrderStatus(pendingOrder.merchantOrderNo);
          }
        } catch {
          // 在线服务暂时不可用时保留订单，后续周期继续确认。
        }
      }
    } finally {
      pendingOrderCheckRunning = false;
    }
  };

  /** 每分钟检查档位，仅每五分钟持久化一次普通运行增量。 */
  const timer = setInterval(() => {
    try {
      const now = checkpointRuntime();
      const crossedBucket = processRuntimePrompt();
      if (crossedBucket || now - lastPersistedAt >= RUNTIME_PERSIST_INTERVAL_MS) {
        tryPersist('保存累计使用时间');
      }
      void checkPendingOrder();
    } catch (error) {
      console.warn('[donation] 累计使用时间检查失败', error?.message || String(error));
    }
  }, RUNTIME_CHECK_INTERVAL_MS);

  const pendingOrderStartupTimer = setTimeout(() => void checkPendingOrder(), 1000);

  return {
    getConfig: () => requestDonationApi('/payments/config'),
    async createTip(request) {
      const intent = await requestDonationApi('/payments/tip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (intent.channel === 'xorpay' && intent.merchant_order_no) {
        state.pendingOrders = state.pendingOrders.filter((item) => item.merchantOrderNo !== intent.merchant_order_no);
        state.pendingOrders.push({
          merchantOrderNo: intent.merchant_order_no,
          expiresAt: Date.now() + Math.max(60, Number(intent.expires_in) || 7200) * 1000,
        });
        checkpointRuntime();
        tryPersist('保存待支付订单');
      }
      return intent;
    },
    getOrderStatus,
    finalizeOrderStatus,
    recordWordExport({ deferPrompt = false } = {}) {
      checkpointRuntime();
      state.wordExportClicks += 1;
      const bucket = Math.floor(state.wordExportClicks / EXPORT_PROMPT_INTERVAL);
      let prompt = null;
      if (bucket > state.processedExportBucket) {
        state.processedExportBucket = bucket;
        if (!donated) prompt = summary('word-export');
      }
      tryPersist('保存 Word 导出次数');
      if (prompt && !deferPrompt) onPrompt?.(prompt);
      return prompt;
    },
    showPrompt(prompt) {
      if (prompt && !donated) {
        checkpointRuntime();
        onPrompt?.(summary(prompt.reason));
      }
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      clearTimeout(pendingOrderStartupTimer);
      checkpointRuntime();
      tryPersist('保存退出时累计状态');
    },
  };
}

module.exports = {
  createDonationService,
};
