const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { dialog } = require('electron');
const { fetch } = require('undici');
const { getLicenseFilePath } = require('../utils/paths.cjs');

const packageJson = require('../../package.json');

const LICENSE_ENDPOINT = process.env.YIBIAO_LICENSE_ENDPOINT || 'https://analytics.agnet.top/license/activate';
const PROJECT_NAME = packageJson.name || 'yibiao-client';
const APP_ID = packageJson.build?.appId || 'com.yibiao.openbidkit';
const PRODUCT_NAME = packageJson.build?.productName || '易标投标工具箱';
const FINGERPRINT_VERSION = '2026-01';
const SIGNATURE_ALGORITHM = 'ECDSA_P256_SHA256';
const OFFLINE_LICENSE_CODE_PREFIX = 'YB-LICENSE-';

const resourcesDir = path.join(__dirname, '..', 'resources');
const publicKeyPath = path.join(resourcesDir, 'license-public-key.json');
const buildAttestationPath = path.join(resourcesDir, 'build-attestation.json');

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function base64UrlDecode(value) {
  const text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = `${text}${'='.repeat((4 - (text.length % 4)) % 4)}`;
  return Buffer.from(padded, 'base64');
}

function base64UrlDecodeText(value) {
  return base64UrlDecode(value).toString('utf-8');
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, data) {
  let tempFile = '';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempFile, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    if (tempFile) {
      try { fs.rmSync(tempFile, { force: true }); } catch {}
    }
    throw error;
  }
}

function hashHex(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf-8').digest('hex');
}

function normalizeDateText(value) {
  return String(value || '').slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function isExpired(expiresAt) {
  const date = new Date(expiresAt);
  return !expiresAt || Number.isNaN(date.getTime()) || date.getTime() <= Date.now();
}

function getPublicJwk() {
  const publicJwk = readJsonFile(publicKeyPath);
  return publicJwk && typeof publicJwk === 'object' ? publicJwk : null;
}

async function verifyPayload(publicJwk, payload, signature) {
  if (!publicJwk || !signature) return false;
  try {
    const key = await crypto.webcrypto.subtle.importKey(
      'jwk',
      { ...publicJwk, key_ops: ['verify'], ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return await crypto.webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64UrlDecode(signature),
      Buffer.from(canonicalJson(payload), 'utf-8'),
    );
  } catch {
    return false;
  }
}

function readBuildAttestation() {
  const attestation = readJsonFile(buildAttestationPath);
  if (!attestation || typeof attestation !== 'object') {
    return null;
  }
  return attestation;
}

async function verifyBuildAttestation(publicJwk, attestation) {
  if (!attestation) {
    return { trusted: false, reason: 'build_attestation_missing' };
  }
  const { signature, ...payload } = attestation;
  if (payload.algorithm && payload.algorithm !== SIGNATURE_ALGORITHM) {
    return { trusted: false, reason: 'build_signature_algorithm_mismatch' };
  }
  const trusted = await verifyPayload(publicJwk, payload, signature);
  return {
    trusted,
    reason: trusted ? '' : 'build_signature_invalid',
  };
}

function readWindowsMachineGuid() {
  try {
    const output = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 3000,
    });
    return output.match(/MachineGuid\s+REG_\w+\s+([^\r\n]+)/i)?.[1]?.trim() || '';
  } catch {
    return '';
  }
}

function readMacMachineId() {
  try {
    const output = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
      encoding: 'utf-8',
      timeout: 3000,
    });
    return output.match(/"IOPlatformUUID"\s+=\s+"([^"]+)"/)?.[1]?.trim() || '';
  } catch {
    return '';
  }
}

function readLinuxMachineId() {
  for (const filePath of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const value = fs.readFileSync(filePath, 'utf-8').trim();
      if (value) return value;
    } catch {}
  }
  return '';
}

function getOsMachineId() {
  const value = process.platform === 'win32'
    ? readWindowsMachineGuid()
    : process.platform === 'darwin'
    ? readMacMachineId()
    : readLinuxMachineId();
  return value || `${process.platform}:${os.hostname()}`;
}

function getMacFingerprint() {
  const macs = [];
  const interfaces = os.networkInterfaces();
  for (const items of Object.values(interfaces)) {
    for (const item of items || []) {
      const mac = String(item.mac || '').toLowerCase();
      if (!mac || mac === '00:00:00:00:00:00' || item.internal) continue;
      macs.push(mac);
    }
  }
  return hashHex(Array.from(new Set(macs)).sort().join('|'));
}

function createMachineFingerprintHash({ clientId }) {
  const raw = PROJECT_NAME
    + APP_ID
    + clientId
    + clientId
    + getOsMachineId()
    + getMacFingerprint()
    + FINGERPRINT_VERSION;
  return hashHex(raw);
}

function normalizeLicenseEnvelope(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const payload = value.payload && typeof value.payload === 'object' ? value.payload : null;
  const signature = String(value.signature || '').trim();
  if (!payload || !signature) {
    return null;
  }
  return {
    payload,
    signature,
    local: value.local && typeof value.local === 'object' ? value.local : {},
  };
}

function parseLicenseEnvelopeText(value) {
  const rawText = String(value || '').trim();
  if (!rawText) {
    return null;
  }

  const jsonText = rawText.startsWith(OFFLINE_LICENSE_CODE_PREFIX)
    ? base64UrlDecodeText(rawText.slice(OFFLINE_LICENSE_CODE_PREFIX.length))
    : rawText;
  const parsed = JSON.parse(jsonText);
  return normalizeLicenseEnvelope(parsed?.license || parsed);
}

function isOfflineLicensePayload(payload) {
  return payload?.activationMode === 'offline' || payload?.plan === 'offline';
}

function normalizeBuildSnapshot(build) {
  const source = build && typeof build === 'object' ? build : {};
  return {
    buildId: String(source.buildId || ''),
    gitCommitSha: String(source.gitCommitSha || ''),
    builtAt: String(source.builtAt || ''),
    keyId: String(source.keyId || ''),
  };
}

function isLicenseBuildCurrent(payload, buildAttestation) {
  const licenseBuild = normalizeBuildSnapshot(payload?.build);
  const currentBuild = normalizeBuildSnapshot(buildAttestation);
  return licenseBuild.buildId === currentBuild.buildId
    && licenseBuild.gitCommitSha === currentBuild.gitCommitSha
    && licenseBuild.builtAt === currentBuild.builtAt
    && licenseBuild.keyId === currentBuild.keyId;
}

function createBaseStatus(partial = {}) {
  return {
    status: 'missing',
    plan: 'free',
    expiresAt: '',
    licenseExpiresAt: '',
    licenseStatus: 'missing',
    activationMode: 'online',
    sourceTrusted: false,
    sourceTrustedText: 'false',
    untrustedReason: partial.untrustedReason || 'license_missing',
    machineFingerprintHash: '',
    fingerprintVersion: FINGERPRINT_VERSION,
    buildTrusted: false,
    buildChanged: false,
    buildId: '',
    keyId: '',
    lastCheckedAt: nowIso(),
    config: {
      freeLicenseDays: 30,
      expirePopupEnabled: true,
      expirePopupDismissible: true,
    },
    ...partial,
  };
}

function createDebugDisabledStatus(partial = {}) {
  return createBaseStatus({
    status: 'debug_disabled',
    plan: 'free',
    licenseStatus: 'debug_disabled',
    activationMode: 'debug_disabled',
    sourceTrusted: true,
    sourceTrustedText: 'true',
    untrustedReason: '',
    buildTrusted: true,
    buildChanged: false,
    buildId: 'local-debug',
    keyId: 'local-debug',
    config: {
      freeLicenseDays: 30,
      expirePopupEnabled: false,
      expirePopupDismissible: true,
    },
    ...partial,
  });
}

function statusFromPayload(payload, status, extra = {}) {
  const activationMode = String(payload.activationMode || (payload.plan === 'offline' ? 'offline' : 'online'));
  const buildTrusted = extra.buildTrusted !== undefined ? Boolean(extra.buildTrusted) : payload.sourceTrusted === true;
  const sourceTrusted = extra.forceSourceTrusted !== undefined
    ? Boolean(extra.forceSourceTrusted)
    : payload.sourceTrusted === true && buildTrusted;
  return createBaseStatus({
    status,
    plan: String(payload.plan || 'free'),
    expiresAt: String(payload.expiresAt || ''),
    licenseExpiresAt: normalizeDateText(payload.expiresAt),
    licenseStatus: status,
    activationMode,
    sourceTrusted,
    sourceTrustedText: sourceTrusted ? 'true' : 'false',
    untrustedReason: sourceTrusted ? '' : String(extra.untrustedReason || payload.untrustedReason || 'build_signature_invalid'),
    machineFingerprintHash: String(payload.machineFingerprintHash || ''),
    fingerprintVersion: String(payload.fingerprintVersion || FINGERPRINT_VERSION),
    buildTrusted,
    buildChanged: activationMode === 'offline' ? false : Boolean(extra.buildChanged),
    buildId: String(payload.build?.buildId || ''),
    keyId: String(payload.keyId || payload.build?.keyId || ''),
    config: {
      freeLicenseDays: Number(payload.config?.freeLicenseDays || 30),
      expirePopupEnabled: payload.config?.expirePopupEnabled !== false,
      expirePopupDismissible: payload.config?.expirePopupDismissible !== false,
    },
  });
}

function createLicenseService({ app, configStore }) {
  const licenseFile = getLicenseFilePath(app);
  const debugLicenseDisabled = !app.isPackaged;
  let currentStatus = debugLicenseDisabled ? createDebugDisabledStatus() : createBaseStatus();

  function buildContext() {
    const config = configStore.load();
    const clientId = config.analytics_client_id || '';
    const clientCreatedAt = config.analytics_created_at || '';
    const machineFingerprintHash = createMachineFingerprintHash({ clientId });
    return {
      clientId,
      clientCreatedAt,
      machineFingerprintHash,
      fingerprintVersion: FINGERPRINT_VERSION,
    };
  }

  async function evaluateLocalLicense(context) {
    if (debugLicenseDisabled) {
      currentStatus = createDebugDisabledStatus();
      return currentStatus;
    }

    const runtimeContext = context || buildContext();
    const publicJwk = getPublicJwk();
    const buildAttestation = readBuildAttestation();
    const buildTrust = await verifyBuildAttestation(publicJwk, buildAttestation);
    const envelope = normalizeLicenseEnvelope(readJsonFile(licenseFile));
    const buildInfo = buildAttestation || {};
    const base = {
      machineFingerprintHash: runtimeContext.machineFingerprintHash,
      buildTrusted: buildTrust.trusted,
      buildId: String(buildInfo.buildId || ''),
      keyId: String(buildInfo.keyId || ''),
      sourceTrusted: buildTrust.trusted,
      sourceTrustedText: buildTrust.trusted ? 'true' : 'false',
      untrustedReason: buildTrust.trusted ? '' : buildTrust.reason,
    };

    if (!envelope) {
      currentStatus = createBaseStatus({ ...base, status: 'missing', licenseStatus: 'missing' });
      return currentStatus;
    }

    if (envelope.local?.invalidated) {
      currentStatus = statusFromPayload(envelope.payload, 'invalidated', {
        ...base,
        forceSourceTrusted: false,
        untrustedReason: String(envelope.local.invalidatedReason || 'license_invalidated'),
      });
      return currentStatus;
    }

    const signatureValid = await verifyPayload(publicJwk, envelope.payload, envelope.signature);
    if (!signatureValid) {
      currentStatus = statusFromPayload(envelope.payload, 'invalid', {
        ...base,
        forceSourceTrusted: false,
        untrustedReason: 'license_signature_invalid',
      });
      return currentStatus;
    }

    const payload = envelope.payload;
    const offlineLicense = isOfflineLicensePayload(payload);
    const buildChanged = offlineLicense ? false : !isLicenseBuildCurrent(payload, buildAttestation);
    if (payload.clientId !== runtimeContext.clientId || (payload.machineFingerprintHash && payload.machineFingerprintHash !== runtimeContext.machineFingerprintHash)) {
      invalidateLocalLicense(envelope, 'license_machine_mismatch');
      currentStatus = statusFromPayload(payload, 'machine_mismatch', {
        ...base,
        buildChanged,
        forceSourceTrusted: false,
        untrustedReason: 'license_machine_mismatch',
      });
      return currentStatus;
    }

    if (isExpired(payload.expiresAt)) {
      currentStatus = statusFromPayload(payload, 'expired', { ...base, buildChanged });
      return currentStatus;
    }

    currentStatus = statusFromPayload(payload, 'active', { ...base, buildChanged });
    return currentStatus;
  }

  function invalidateLocalLicense(envelope, reason) {
    try {
      writeJsonAtomic(licenseFile, {
        ...envelope,
        local: {
          ...(envelope.local || {}),
          invalidated: true,
          invalidatedReason: reason,
          invalidatedAt: nowIso(),
        },
      });
    } catch (error) {
      console.warn('[license] 写入授权失效状态失败', error?.message || String(error));
    }
  }

  async function refreshLicense() {
    if (debugLicenseDisabled) {
      return evaluateLocalLicense();
    }

    const context = buildContext();
    const localStatus = await evaluateLocalLicense(context);
    if (localStatus.activationMode === 'offline') {
      return localStatus;
    }

    const buildAttestation = readBuildAttestation();
    const body = {
      projectName: PROJECT_NAME,
      appId: APP_ID,
      productName: PRODUCT_NAME,
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      clientId: context.clientId,
      clientCreatedAt: context.clientCreatedAt,
      machineFingerprintHash: context.machineFingerprintHash,
      fingerprintVersion: context.fingerprintVersion,
      buildAttestation,
    };

    try {
      const response = await fetch(LICENSE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.code !== 0 || !data.license) {
        throw new Error(data?.message || `授权刷新失败：${response.status}`);
      }
      const envelope = normalizeLicenseEnvelope(data.license);
      if (!envelope) {
        throw new Error('授权服务返回的数据格式不完整');
      }
      writeJsonAtomic(licenseFile, {
        ...envelope,
        local: {
          refreshedAt: nowIso(),
        },
      });
      return evaluateLocalLicense(context);
    } catch (error) {
      const localStatus = await evaluateLocalLicense(context);
      currentStatus = {
        ...localStatus,
        status: localStatus.status === 'active' ? localStatus.status : 'refresh_failed',
        licenseStatus: localStatus.status === 'active' ? localStatus.licenseStatus : 'refresh_failed',
        refreshError: error?.message || String(error),
        lastCheckedAt: nowIso(),
      };
      return currentStatus;
    }
  }

  async function refreshOnStartup() {
    const status = await evaluateLocalLicense();
    if (status.activationMode === 'offline') {
      return status;
    }
    if (status.status === 'active' && status.buildChanged) {
      return refreshLicense();
    }
    if (status.status === 'active' || status.status === 'machine_mismatch' || status.status === 'invalidated') {
      return status;
    }
    return refreshLicense();
  }

  async function activateOfflineLicenseEnvelope(envelope) {
    if (debugLicenseDisabled) {
      return {
        success: false,
        message: '开发调试模式不需要离线激活授权',
        status: await evaluateLocalLicense(),
      };
    }

    const normalizedEnvelope = normalizeLicenseEnvelope(envelope);
    if (!normalizedEnvelope) {
      throw new Error('离线授权数据格式不完整');
    }

    const publicJwk = getPublicJwk();
    const signatureValid = await verifyPayload(publicJwk, normalizedEnvelope.payload, normalizedEnvelope.signature);
    if (!signatureValid) {
      throw new Error('离线授权签名无效');
    }

    const context = buildContext();
    const payload = normalizedEnvelope.payload;
    if (payload.clientId !== context.clientId) {
      throw new Error('离线授权不属于当前客户端');
    }
    if (payload.machineFingerprintHash && payload.machineFingerprintHash !== context.machineFingerprintHash) {
      throw new Error('离线授权不属于当前设备');
    }
    if (isExpired(payload.expiresAt)) {
      throw new Error('离线授权已过期');
    }

    writeJsonAtomic(licenseFile, {
      ...normalizedEnvelope,
      local: {
        activatedAt: nowIso(),
        activationMode: 'offline',
      },
    });
    const status = await evaluateLocalLicense(context);
    return {
      success: status.status === 'active',
      message: status.status === 'active' ? '离线授权已激活' : '离线授权已导入，但授权状态异常',
      status,
    };
  }

  async function activateOfflineLicenseText(value) {
    let envelope;
    try {
      envelope = parseLicenseEnvelopeText(value);
    } catch {
      throw new Error('离线授权码格式无效');
    }
    return activateOfflineLicenseEnvelope(envelope);
  }

  async function importOfflineLicenseFile() {
    if (debugLicenseDisabled) {
      return {
        success: false,
        message: '开发调试模式不需要离线激活授权',
        status: await evaluateLocalLicense(),
      };
    }

    const result = await dialog.showOpenDialog({
      title: '选择离线授权文件',
      properties: ['openFile'],
      filters: [
        { name: '易标离线授权文件', extensions: ['json', 'license', 'txt'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return {
        success: false,
        canceled: true,
        message: '已取消选择',
        status: await evaluateLocalLicense(),
      };
    }

    const content = fs.readFileSync(result.filePaths[0], 'utf-8');
    return activateOfflineLicenseText(content);
  }

  return {
    getLicenseFilePath() {
      return licenseFile;
    },
    getBuildAttestation() {
      return readBuildAttestation();
    },
    getStatus() {
      return evaluateLocalLicense();
    },
    refresh() {
      return refreshLicense();
    },
    importOfflineFile() {
      return importOfflineLicenseFile();
    },
    activateOfflineCode(code) {
      return activateOfflineLicenseText(code);
    },
    refreshOnStartup,
    getCurrentStatus() {
      return currentStatus;
    },
  };
}

module.exports = {
  createLicenseService,
};
