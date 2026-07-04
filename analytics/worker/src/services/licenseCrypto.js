function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function base64UrlEncode(value) {
  let binary = '';
  const bytes = new Uint8Array(value);
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = `${text}${'='.repeat((4 - (text.length % 4)) % 4)}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function parseJwk(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const jwk = JSON.parse(text);
    return jwk && typeof jwk === 'object' ? jwk : null;
  } catch {
    return null;
  }
}

export function getPrivateJwk(env) {
  return parseJwk(env.LICENSE_PRIVATE_KEY_JWK || env.YIBIAO_LICENSE_PRIVATE_KEY_JWK);
}

export function publicJwkFromPrivate(privateJwk) {
  if (!privateJwk) return null;
  const { kty, crv, x, y } = privateJwk;
  if (!kty || !crv || !x || !y) return null;
  return { key_ops: ['verify'], ext: true, kty, crv, x, y };
}

export function getPublicJwk(env) {
  return parseJwk(env.LICENSE_PUBLIC_KEY_JWK || env.YIBIAO_LICENSE_PUBLIC_KEY_JWK) || publicJwkFromPrivate(getPrivateJwk(env));
}

export async function signPayload(env, payload) {
  const privateJwk = getPrivateJwk(env);
  if (!privateJwk?.d) {
    throw new Error('LICENSE_PRIVATE_KEY_JWK is not configured');
  }
  const key = await crypto.subtle.importKey(
    'jwk',
    { ...privateJwk, key_ops: ['sign'], ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const data = new TextEncoder().encode(canonicalJson(payload));
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data);
  return base64UrlEncode(signature);
}

export async function verifyPayload(publicJwk, payload, signature) {
  if (!publicJwk || !signature) return false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { ...publicJwk, key_ops: ['verify'], ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64UrlDecode(signature),
      new TextEncoder().encode(canonicalJson(payload)),
    );
  } catch {
    return false;
  }
}

export async function verifySignedObject(env, signedObject) {
  if (!signedObject || typeof signedObject !== 'object') {
    return false;
  }
  const { signature, ...payload } = signedObject;
  return verifyPayload(getPublicJwk(env), payload, signature);
}
