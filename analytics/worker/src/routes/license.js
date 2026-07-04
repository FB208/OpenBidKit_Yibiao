import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { readLicenseConfig, saveLicenseConfig } from '../services/licenseStore.js';
import { signPayload, verifySignedObject } from '../services/licenseCrypto.js';
import { isValidProjectName, normalizeText } from '../utils.js';

const LICENSE_PLANS = new Set(['free', 'personal_premium', 'enterprise_premium']);
const FINGERPRINT_VERSION = '2026-01';

function addDaysIso(days) {
  return new Date(Date.now() + Math.max(1, Number(days || 1)) * 86400000).toISOString();
}

function normalizeBooleanText(value) {
  return value === true ? 'true' : 'false';
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
      expirePopupDismissible: config.expirePopupDismissible === true,
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
