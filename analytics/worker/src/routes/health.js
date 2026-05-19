import { WORKER_CODE_VERSION } from '../constants.js';
import { json } from '../http.js';

export function handleHealth(env) {
  return json({
    code: 0,
    ok: true,
    workerCodeVersion: WORKER_CODE_VERSION,
    noticeTimeFormat: 'YYYY-MM-DD HH:mm:ss Asia/Shanghai',
    noticeStoreConfigured: Boolean(env.NOTICE_STORE),
  });
}
