import { corsHeaders, json, methodNotAllowed } from '../http.js';
import {
  normalizeTrackBody,
  validateTrackEvent,
  writeAnalyticsDataPoint,
} from '../services/analyticsTrack.js';
import { recordTrackClient } from '../services/analyticsStatsStore.js';
import { isTrackVersionBlocked } from '../services/blockRuleStore.js';

export async function handleTrack(request, env) {
  if (request.method !== 'POST') {
    return methodNotAllowed();
  }

  try {
    const body = await request.json();
    const event = normalizeTrackBody(body, request);
    const validationError = validateTrackEvent(event);
    if (validationError) {
      return json({ code: 400, message: validationError }, { status: 400 });
    }
    if (await isTrackVersionBlocked(env, event.projectName, event.version)) {
      return new Response(null, { status: 204, headers: corsHeaders });
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
