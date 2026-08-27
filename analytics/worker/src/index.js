import { corsHeaders, json } from './http.js';
import { handleAgentRuntime } from './routes/agentRuntime.js';
import { handleAdminAgentErrorConfig, handleAdminAgentErrorDownload, handleAdminAgentErrors, handleAgentErrorIngest } from './routes/agentErrors.js';
import { handleClients, handleClientDetail, handleIpStats } from './routes/clients.js';
import { handleConfigUsage, handleModelUsage } from './routes/configUsage.js';
import { handleGitHubRepoStats } from './routes/githubRepoStats.js';
import { handleHealth } from './routes/health.js';
import { handleAdminIpBlocks, handlePublicIpBlocks } from './routes/ipBlocks.js';
import { handleLatest } from './routes/latest.js';
import { handleLicenseActivate, handleLicenseConfig, handleOfflineLicense } from './routes/license.js';
import { handleAdminModelInfoCache, handleAdminModelInfoOverride, handlePublicModelInfo } from './routes/modelInfo.js';
import { handleAdminNotice, handlePublicNotice } from './routes/notice.js';
import { handleOverview } from './routes/overview.js';
import { handleProjects } from './routes/projects.js';
import { handleRetention } from './routes/retention.js';
import { handleAdminResources, handlePublicResources, handleResourceImage } from './routes/resources.js';
import { handleAdminPluginSync, handleAdminPlugins, handlePublicPluginDownload, handlePublicPlugins } from './routes/plugins.js';
import { handleTrack } from './routes/track.js';
import { handleTraffic } from './routes/traffic.js';
import { MODEL_INFO_SYNC_CRON } from './constants.js';
import { syncModelInfoCache } from './services/modelInfoCache.js';
import { cleanupExpiredAgentErrors } from './services/agentErrorStore.js';
import { isRequestIpBlocked } from './services/ipBlockStore.js';
import {
  OVERVIEW_AI_TOTALS_CRON,
  refreshOverviewAiTotals,
  rollupYesterdayCronStage,
} from './services/analyticsStatsStore.js';

const routes = new Map([
  ['/health', (request, env) => handleHealth(env)],
  ['/ip-blocks', handlePublicIpBlocks],
  ['/track', handleTrack],
  ['/agent-errors', handleAgentErrorIngest],
  ['/license/activate', handleLicenseActivate],
  ['/notice', handlePublicNotice],
  ['/model-info', handlePublicModelInfo],
  ['/resources', handlePublicResources],
  ['/resource-image', handleResourceImage],
  ['/plugins', handlePublicPlugins],
  ['/plugins/download', handlePublicPluginDownload],
  ['/api/projects', handleProjects],
  ['/api/notice', handleAdminNotice],
  ['/api/model-info-cache', handleAdminModelInfoCache],
  ['/api/model-info-cache/override', handleAdminModelInfoOverride],
  ['/api/resources', handleAdminResources],
  ['/api/plugins', handleAdminPlugins],
  ['/api/plugins/sync', handleAdminPluginSync],
  ['/api/overview', handleOverview],
  ['/api/clients', handleClients],
  ['/api/client-detail', handleClientDetail],
  ['/api/ip-stats', handleIpStats],
  ['/api/traffic', handleTraffic],
  ['/api/latest', handleLatest],
  ['/api/license-config', handleLicenseConfig],
  ['/api/license/offline', handleOfflineLicense],
  ['/api/retention', handleRetention],
  ['/api/config-usage', handleConfigUsage],
  ['/api/model-usage', handleModelUsage],
  ['/api/agent-runtime', handleAgentRuntime],
  ['/api/agent-errors/config', handleAdminAgentErrorConfig],
  ['/api/agent-errors/download', handleAdminAgentErrorDownload],
  ['/api/agent-errors', handleAdminAgentErrors],
  ['/api/github-repo-stats', handleGitHubRepoStats],
  ['/api/ip-blocks', handleAdminIpBlocks],
]);

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/ip-blocks' && !url.pathname.startsWith('/api/') && await isRequestIpBlocked(env, request)) {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    const handler = routes.get(url.pathname);
    if (handler) {
      return handler(request, env, url);
    }

    return json({ code: 404, message: 'not found' }, { status: 404 });
  },

  async scheduled(event, env) {
    const cron = event?.cron || '';
    if (cron === MODEL_INFO_SYNC_CRON) {
      await syncModelInfoCache(env, 'cron');
      return;
    }
    await rollupYesterdayCronStage(env, cron);
    if (cron === '0 19 * * *') {
      try {
        await cleanupExpiredAgentErrors(env);
      } catch (error) {
        console.error('[analytics] agent error cleanup failed', error?.message || String(error));
      }
    }
    if (cron === OVERVIEW_AI_TOTALS_CRON) {
      try {
        await refreshOverviewAiTotals(env);
      } catch (error) {
        console.error('[analytics] overview AI totals refresh failed', error?.message || String(error));
      }
    }
  },
};
