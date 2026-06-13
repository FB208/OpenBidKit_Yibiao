import { json, methodNotAllowed } from '../http.js';
import {
  enqueueAnalyticsRollup,
  normalizeTrackBody,
  validateTrackEvent,
  writeAnalyticsDataPoint,
} from '../services/analyticsRollup.js';

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

    await enqueueAnalyticsRollup(env, event);

    try {
      writeAnalyticsDataPoint(env, event);
    } catch (error) {
      console.error('[analytics] analytics engine write failed', error?.message || String(error));
    }

    return json({ code: 0, eventId: event.eventId }, { status: 202 });
  } catch (error) {
    console.error('[analytics] track failed', error?.message || String(error));
    return json({ code: 500, message: 'internal error' }, { status: 500 });
  }
}
