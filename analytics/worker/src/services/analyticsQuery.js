const retryableStatuses = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export async function queryAnalytics(env, sql) {
  if (!env.ACCOUNT_ID || !env.ANALYTICS_API_TOKEN) {
    throw new Error('missing analytics api config');
  }

  const api = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/analytics_engine/sql`;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(api, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ANALYTICS_API_TOKEN}`,
      },
      body: sql,
    });
    const text = await response.text();

    if (response.ok) {
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new Error(`Analytics Engine query returned invalid JSON: ${error?.message || String(error)}; sql=${compactSql(sql)}`);
      }
    }

    const retryable = retryableStatuses.has(response.status) && attempt < 4;
    const message = `Analytics Engine query failed: status=${response.status}; attempt=${attempt}; body=${text.slice(0, 1000)}; sql=${compactSql(sql)}`;
    if (!retryable) {
      throw new Error(message);
    }

    console.warn(`[analytics] ${message}; retrying`);
    await sleep(500 * attempt);
  }

  throw new Error(`Analytics Engine query failed after retries; sql=${compactSql(sql)}`);
}
