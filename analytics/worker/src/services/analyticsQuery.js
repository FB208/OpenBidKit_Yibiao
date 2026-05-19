export async function queryAnalytics(env, sql) {
  if (!env.ACCOUNT_ID || !env.ANALYTICS_API_TOKEN) {
    throw new Error('missing analytics api config');
  }

  const api = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/analytics_engine/sql`;
  const response = await fetch(api, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.ANALYTICS_API_TOKEN}`,
    },
    body: sql,
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}
