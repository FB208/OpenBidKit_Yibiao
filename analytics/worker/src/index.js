import { corsHeaders, json } from './http.js';
import { handleConfigUsage } from './routes/configUsage.js';
import { handleGitHubRepoStats } from './routes/githubRepoStats.js';
import { handleHealth } from './routes/health.js';
import { handleLatest } from './routes/latest.js';
import { handleAdminNotice, handlePublicNotice } from './routes/notice.js';
import { handleProjects } from './routes/projects.js';
import { handleRetention } from './routes/retention.js';
import { handleAdminResources, handlePublicResources, handleResourceImage } from './routes/resources.js';
import { handleSummary } from './routes/summary.js';
import { handleTrack } from './routes/track.js';

const routes = new Map([
  ['/health', (request, env) => handleHealth(env)],
  ['/track', handleTrack],
  ['/notice', handlePublicNotice],
  ['/resources', handlePublicResources],
  ['/resource-image', handleResourceImage],
  ['/api/projects', handleProjects],
  ['/api/notice', handleAdminNotice],
  ['/api/resources', handleAdminResources],
  ['/api/summary', handleSummary],
  ['/api/latest', handleLatest],
  ['/api/retention', handleRetention],
  ['/api/config-usage', handleConfigUsage],
  ['/api/github-repo-stats', handleGitHubRepoStats],
]);

export default {
  async fetch(request, env) {
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const url = new URL(request.url);
      const handler = routes.get(url.pathname);
      if (handler) {
        return handler(request, env, url);
      }

      return json({ code: 404, message: 'not found' }, { status: 404 });
    } catch (e) {
      console.error('Unhandled worker error:', e);
      return json({ code: 500, message: 'internal server error' }, { status: 500 });
    }
  },
};