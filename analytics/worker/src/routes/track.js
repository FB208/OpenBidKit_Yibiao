import { json, methodNotAllowed } from '../http.js';
import {
  normalizeTrackBody,
  validateTrackEvent,
  writeAnalyticsDataPoint,
} from '../services/analyticsTrack.js';

export async function handleTrack(request, env) {
  if (request.method !== 'POST') {
    return methodNotAllowed();
  }

  try {
    const body = await request.json();
    const event = normalizeTrackBody(body);
    const validationError = validateTrackEvent(event);
    if (validationError) {
      return json({ code: 400, message: validationError }, { status: 400 });
    }

    writeAnalyticsDataPoint(env, event);

    return json({ code: 0 });
  } catch (error) {
    console.error('[analytics] track failed', error?.message || String(error));
    return json({ code: 500, message: 'internal error' }, { status: 500 });
  }
}
