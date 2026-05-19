import { corsHeaders, json } from './http.js';
import { handleConfigUsage } from './routes/configUsage.js';
import { handleHealth } from './routes/health.js';
import { handleLatest } from './routes/latest.js';
import { handleAdminNotice, handlePublicNotice } from './routes/notice.js';
import { handleProjects } from './routes/projects.js';
import { handleRetention } from './routes/retention.js';
import { handleSummary } from './routes/summary.js';
import { handleTrack } from './routes/track.js';

const routes = new Map([
  ['/health', (request, env) => handleHealth(env)],
  ['/track', handleTrack],
  ['/notice', handlePublicNotice],
  ['/api/projects', handleProjects],
  ['/api/notice', handleAdminNotice],
  ['/api/summary', handleSummary],
  ['/api/latest', handleLatest],
  ['/api/retention', handleRetention],
  ['/api/config-usage', handleConfigUsage],
]);

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const handler = routes.get(url.pathname);
    if (handler) {
      return handler(request, env, url);
    }

    return json({ code: 404, message: 'not found' }, { status: 404 });
  },
};
