import { corsHeaders, json, methodNotAllowed } from '../http.js';
import { VERSION_FORMAT_PATTERN } from '../constants.js';
import {
  normalizeTrackBody,
  validateTrackEvent,
  writeAnalyticsDataPoint,
} from '../services/analyticsTrack.js';
import { recordTrackClient } from '../services/analyticsStatsStore.js';
import { isTrackVersionBlocked } from '../services/versionBlockStore.js';
import { isValidProjectName } from '../utils.js';

export async function handleTrack(request, env) {
  if (request.method !== 'POST') {
    return methodNotAllowed();
  }

  try {
    const body = await request.json();
    const event = normalizeTrackBody(body, request);
    if (!VERSION_FORMAT_PATTERN.test(event.version)) {
      // 版本号格式不合法（含空版本号）：静默丢弃，不触发当天客户端数据清理。
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (isValidProjectName(event.projectName) && await isTrackVersionBlocked(env, event.projectName, event.version)) {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    const validationError = validateTrackEvent(event);
    if (validationError) {
      return json({ code: 400, message: validationError }, { status: 400 });
    }

    writeAnalyticsDataPoint(env, event);
    try {
      await recordTrackClient(env, event);
    } catch (error) {
      console.warn('[analytics] realtime client record failed', error?.message || String(error));
    }

    return json({ code: 0 });
  } catch (error) {
    console.error('[analytics] track failed', error?.message || String(error));
    return json({ code: 500, message: 'internal error' }, { status: 500 });
  }
}
