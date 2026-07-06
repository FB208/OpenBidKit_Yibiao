import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { readLicenseConfig, saveLicenseConfig } from '../services/licenseStore.js';
import { signPayload, verifySignedObject } from '../services/licenseCrypto.js';
import { isValidProjectName, normalizeText } from '../utils.js';

const LICENSE_PLANS = new Set(['free', 'personal_premium', 'enterprise_premium']);
const FINGERPRINT_VERSION = '2026-01';
const OFFLINE_LICENSE_CODE_PREFIX = 'YB-LICENSE-';
const DEFAULT_APP_ID = 'com.yibiao.openbidkit';
const DEFAULT_PRODUCT_NAME = '易标投标工具箱';

function addDaysIso(days) {
  return new Date(Date.now() + Math.max(1, Number(days || 1)) * 86400000).toISOString();
}

function normalizeBooleanText(value) {
  return value === true ? 'true' : 'false';
}

function normalizeBooleanValue(value, defaultValue = true) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return defaultValue;
}

function normalizeExpiresAt(value) {
  const text = normalizeText(value, 40);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const expiresAt = `${text}T23:59:59.999Z`;
    if (new Date(expiresAt).getTime() <= Date.now()) {
      throw new Error('invalid expiresAt');
    }
    return expiresAt;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
    throw new Error('invalid expiresAt');
  }
  return date.toISOString();
}

function base64UrlEncodeText(value) {
  let binary = '';
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodeOfflineLicenseCode(license) {
  return `${OFFLINE_LICENSE_CODE_PREFIX}${base64UrlEncodeText(JSON.stringify(license))}`;
}

function normalizeBuildInfo(buildAttestation) {
  const source = buildAttestation && typeof buildAttestation === 'object' ? buildAttestation : {};
  return {
    buildId: normalizeText(source.buildId, 120),
    gitCommitSha: normalizeText(source.gitCommitSha, 80),
    builtAt: normalizeText(source.builtAt, 40),
    keyId: normalizeText(source.keyId, 80),
  };
}

export async function handleLicenseActivate(request, env) {
  if (request.method !== 'POST') {
    return methodNotAllowed();
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ code: 400, message: 'invalid json body' }, { status: 400 });
  }

  const projectName = normalizeText(body.projectName || body.project_name, 80);
  const appId = normalizeText(body.appId || body.app_id, 120);
  const productName = normalizeText(body.productName || body.product_name, 120);
  const clientId = normalizeText(body.clientId || body.client_id, 120);
  const clientCreatedAt = normalizeText(body.clientCreatedAt || body.client_created_at, 20).slice(0, 10);
  const machineFingerprintHash = normalizeText(body.machineFingerprintHash || body.machine_fingerprint_hash, 128);
  const fingerprintVersion = normalizeText(body.fingerprintVersion || body.fingerprint_version, 40) || FINGERPRINT_VERSION;

  if (!isValidProjectName(projectName) || !appId || !clientId || !clientCreatedAt || !machineFingerprintHash) {
    return json({ code: 400, message: 'invalid params' }, { status: 400 });
  }

  const buildAttestation = body.buildAttestation || body.build_attestation || null;
  const sourceTrusted = await verifySignedObject(env, buildAttestation);
  const untrustedReason = sourceTrusted ? '' : 'build_signature_invalid';
  const config = await readLicenseConfig(env, projectName);
  const plan = LICENSE_PLANS.has(body.plan) ? body.plan : 'free';
  const payload = {
    schemaVersion: 1,
    projectName,
    appId,
    productName,
    clientId,
    clientCreatedAt,
    machineFingerprintHash,
    fingerprintVersion,
    plan,
    status: 'active',
    issuedAt: new Date().toISOString(),
    expiresAt: addDaysIso(config.freeLicenseDays),
    sourceTrusted,
    sourceTrustedText: normalizeBooleanText(sourceTrusted),
    untrustedReason,
    keyId: normalizeText(env.LICENSE_KEY_ID || env.YIBIAO_LICENSE_KEY_ID || buildAttestation?.keyId || 'official-build-key-2026-01', 80),
    build: normalizeBuildInfo(buildAttestation),
    config: {
      freeLicenseDays: config.freeLicenseDays,
      expirePopupEnabled: config.expirePopupEnabled !== false,
      expirePopupDismissible: config.expirePopupDismissible !== false,
    },
  };

  try {
    const signature = await signPayload(env, payload);
    return json({ code: 0, license: { payload, signature } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[license] activate failed', error?.message || String(error));
    return json({ code: 500, message: 'license signing failed' }, { status: 500 });
  }
}

export async function handleLicenseConfig(request, env, url) {
  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  if (request.method === 'GET') {
    const projectName = normalizeText(url.searchParams.get('projectName'), 80);
    if (!isValidProjectName(projectName)) {
      return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
    }
    return json({ code: 0, config: await readLicenseConfig(env, projectName) }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ code: 400, message: 'invalid json body' }, { status: 400 });
    }
    try {
      return json({ code: 0, config: await saveLicenseConfig(env, body) }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      return json({ code: 400, message: error?.message || 'save failed' }, { status: 400 });
    }
  }

  return methodNotAllowed();
}

export async function handleOfflineLicense(request, env) {
  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  if (request.method !== 'POST') {
    return methodNotAllowed();
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ code: 400, message: 'invalid json body' }, { status: 400 });
  }

  const projectName = normalizeText(body.projectName || body.project_name, 80);
  const clientId = normalizeText(body.clientId || body.client_id, 120);
  if (!isValidProjectName(projectName) || !clientId) {
    return json({ code: 400, message: 'invalid params' }, { status: 400 });
  }

  let expiresAt;
  try {
    expiresAt = normalizeExpiresAt(body.expiresAt || body.expires_at);
  } catch {
    return json({ code: 400, message: 'invalid expiresAt' }, { status: 400 });
  }

  const payload = {
    schemaVersion: 1,
    activationMode: 'offline',
    projectName,
    appId: normalizeText(body.appId || body.app_id, 120) || DEFAULT_APP_ID,
    productName: normalizeText(body.productName || body.product_name, 120) || DEFAULT_PRODUCT_NAME,
    clientId,
    clientCreatedAt: normalizeText(body.clientCreatedAt || body.client_created_at, 20).slice(0, 10),
    machineFingerprintHash: normalizeText(body.machineFingerprintHash || body.machine_fingerprint_hash, 128),
    fingerprintVersion: normalizeText(body.fingerprintVersion || body.fingerprint_version, 40) || FINGERPRINT_VERSION,
    plan: 'offline',
    status: 'active',
    issuedAt: new Date().toISOString(),
    expiresAt,
    sourceTrusted: true,
    sourceTrustedText: 'true',
    untrustedReason: '',
    keyId: normalizeText(env.LICENSE_KEY_ID || env.YIBIAO_LICENSE_KEY_ID || 'official-build-key-2026-01', 80),
    build: normalizeBuildInfo(null),
    config: {
      freeLicenseDays: 30,
      expirePopupEnabled: normalizeBooleanValue(body.expirePopupEnabled ?? body.expire_popup_enabled, true),
      expirePopupDismissible: normalizeBooleanValue(body.expirePopupDismissible ?? body.expire_popup_dismissible, true),
    },
  };

  try {
    const signature = await signPayload(env, payload);
    const license = { payload, signature };
    return json({ code: 0, license, licenseCode: encodeOfflineLicenseCode(license) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[license] offline signing failed', error?.message || String(error));
    return json({ code: 500, message: 'license signing failed' }, { status: 500 });
  }
}
