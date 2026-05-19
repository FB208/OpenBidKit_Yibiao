export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export function json(data, init = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      ...corsHeaders,
      ...(init.headers || {}),
    },
  });
}

export function methodNotAllowed() {
  return json({ code: 405, message: 'method not allowed' }, { status: 405 });
}

export function unauthorized() {
  return json({ code: 401, message: 'unauthorized' }, { status: 401 });
}

export function requireAdmin(request, env) {
  const token = String(env.ADMIN_TOKEN || '');
  const authorization = request.headers.get('Authorization') || '';
  return Boolean(token) && authorization === `Bearer ${token}`;
}
