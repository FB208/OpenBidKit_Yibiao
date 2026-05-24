import {
  GITHUB_REPO_FULL_NAME,
  GITHUB_REPO_STATS_CACHE_KEY,
  GITHUB_REPO_STATS_CACHE_TTL_SECONDS,
  GITHUB_REPO_STATS_STALE_TTL_SECONDS,
} from '../constants.js';
import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';

const GITHUB_REPO_HTML_URL = `https://github.com/${GITHUB_REPO_FULL_NAME}`;

function normalizeCount(value) {
  const text = String(value || '').trim().replace(/,/g, '');
  const match = text.match(/^(\d+(?:\.\d+)?)([km])?$/i);
  if (!match) {
    const number = Number(text.replace(/[^\d.]/g, ''));
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
  }

  const base = Number(match[1]);
  const unit = String(match[2] || '').toLowerCase();
  const multiplier = unit === 'm' ? 1000000 : unit === 'k' ? 1000 : 1;
  return Math.floor(base * multiplier);
}

function normalizeRepoStats(data) {
  if (!data || typeof data !== 'object') {
    return null;
  }

  return {
    fullName: String(data.full_name || data.fullName || GITHUB_REPO_FULL_NAME),
    htmlUrl: String(data.html_url || data.htmlUrl || GITHUB_REPO_HTML_URL),
    stars: normalizeCount(data.stargazers_count ?? data.stars ?? 0),
    forks: normalizeCount(data.forks_count ?? data.forks ?? 0),
    openIssues: normalizeCount(data.open_issues_count ?? data.openIssues ?? 0),
    updatedAt: String(data.updated_at || data.updatedAt || ''),
  };
}

function normalizeCachedStats(data) {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const repo = normalizeRepoStats(data.repo || data);
  if (!repo) {
    return null;
  }

  const fetchedAt = Number(data.fetchedAt || data.fetched_at || 0);
  return {
    repo,
    fetchedAt: Number.isFinite(fetchedAt) && fetchedAt > 0 ? fetchedAt : 0,
  };
}

function isFreshCache(cacheEntry) {
  if (!cacheEntry?.fetchedAt) {
    return false;
  }

  return Date.now() - cacheEntry.fetchedAt < GITHUB_REPO_STATS_CACHE_TTL_SECONDS * 1000;
}

function readElementCountById(html, id) {
  const marker = `id="${id}"`;
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  const tagStart = html.lastIndexOf('<', markerIndex);
  const tagEnd = html.indexOf('>', markerIndex);
  if (tagStart === -1 || tagEnd === -1) {
    return null;
  }

  const tag = html.slice(tagStart, tagEnd + 1);
  const title = tag.match(/\btitle="([^"]+)"/)?.[1] || tag.match(/\baria-label="([^"]+)"/)?.[1] || '';
  if (title) {
    return normalizeCount(title);
  }

  const closeIndex = html.indexOf('</', tagEnd + 1);
  const text = closeIndex === -1 ? '' : html.slice(tagEnd + 1, closeIndex).replace(/<[^>]*>/g, '').trim();
  return text ? normalizeCount(text) : null;
}

function parseRepoStatsFromHtml(html) {
  const stars = readElementCountById(html, 'repo-stars-counter-star');
  const forks = readElementCountById(html, 'repo-network-counter');
  const openIssues = readElementCountById(html, 'issues-repo-tab-count');
  if (stars === null || forks === null || openIssues === null) {
    return null;
  }

  return normalizeRepoStats({
    fullName: GITHUB_REPO_FULL_NAME,
    htmlUrl: GITHUB_REPO_HTML_URL,
    stars,
    forks,
    openIssues,
    updatedAt: '',
  });
}

function buildGitHubHeaders(env) {
  const token = String(env.GITHUB_API_TOKEN || env.GITHUB_TOKEN || '').trim();
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'OpenBidKit-Yibiao-Analytics',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function compactError(error) {
  return String(error?.message || error || '').replace(/\s+/g, ' ').slice(0, 500);
}

async function readCachedStats(env) {
  if (!env.NOTICE_STORE) {
    return null;
  }

  let raw;
  try {
    raw = await env.NOTICE_STORE.get(GITHUB_REPO_STATS_CACHE_KEY);
  } catch (error) {
    console.warn('[analytics] github repo stats cache read failed', error?.message || String(error));
    return null;
  }
  if (!raw) {
    return null;
  }

  try {
    return normalizeCachedStats(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeCachedStats(env, repo) {
  if (!env.NOTICE_STORE || !repo) {
    return;
  }

  try {
    await env.NOTICE_STORE.put(GITHUB_REPO_STATS_CACHE_KEY, JSON.stringify({ repo, fetchedAt: Date.now() }), {
      expirationTtl: GITHUB_REPO_STATS_STALE_TTL_SECONDS,
    });
  } catch (error) {
    console.warn('[analytics] github repo stats cache write failed', error?.message || String(error));
  }
}

async function fetchRepoStatsFromApi(env) {
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO_FULL_NAME}`, {
    headers: buildGitHubHeaders(env),
  });

  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  }

  return normalizeRepoStats(await response.json());
}

async function fetchRepoStatsFromHtml() {
  const response = await fetch(GITHUB_REPO_HTML_URL, {
    headers: {
      Accept: 'text/html',
      'User-Agent': 'OpenBidKit-Yibiao-Analytics',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub HTML ${response.status}: ${await response.text()}`);
  }

  const repo = parseRepoStatsFromHtml(await response.text());
  if (!repo) {
    throw new Error('GitHub HTML stats not found');
  }

  return repo;
}

async function fetchRepoStats(env) {
  try {
    return { repo: await fetchRepoStatsFromApi(env), source: 'github-api' };
  } catch (apiError) {
    console.warn('[analytics] github repo stats api failed, trying html fallback', compactError(apiError));
    try {
      return { repo: await fetchRepoStatsFromHtml(), source: 'github-html' };
    } catch (htmlError) {
      throw new Error(`GitHub API failed: ${compactError(apiError)}; HTML fallback failed: ${compactError(htmlError)}`);
    }
  }
}

export async function handleGitHubRepoStats(request, env) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  const cached = await readCachedStats(env);
  if (isFreshCache(cached)) {
    return json({ code: 0, repo: cached.repo, cached: true, stale: false });
  }

  try {
    const { repo, source } = await fetchRepoStats(env);
    await writeCachedStats(env, repo);
    return json({ code: 0, repo, cached: false, stale: false, source });
  } catch (error) {
    const message = compactError(error);
    console.error('[analytics] github repo stats failed', message);
    if (cached?.repo) {
      return json({ code: 0, repo: cached.repo, cached: true, stale: true, message: 'GitHub 实时数据暂不可用，已返回缓存数据' });
    }

    return json({ code: 502, message: `GitHub 仓库统计读取失败：${message}`, repo: null, cached: false, stale: false }, { status: 502 });
  }
}
