const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const packageJson = require('../../package.json');

const PROJECT_NAME = packageJson.name || 'yibiao-client';
const APP_ID = packageJson.build?.appId || 'com.yibiao.openbidkit';
const CLIENT_ID_VERSION = 'machine-v1';

// 读取 Windows 系统安装标识。
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

// 读取 macOS 平台硬件标识。
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

// 读取 Linux 系统安装标识。
function readLinuxMachineId() {
  for (const filePath of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const value = fs.readFileSync(filePath, 'utf-8').trim();
      if (value) return value;
    } catch {}
  }
  return '';
}

// 返回当前操作系统的稳定机器标识。
function getOsMachineId() {
  const value = process.platform === 'win32'
    ? readWindowsMachineGuid()
    : process.platform === 'darwin'
    ? readMacMachineId()
    : readLinuxMachineId();
  return value || `${process.platform}:${os.hostname()}`;
}

// 仅在配置缺少 Client ID 时生成可重复的机器摘要 ID。
function createAnalyticsClientId() {
  const digest = crypto.createHash('sha256')
    .update(`${CLIENT_ID_VERSION}\0${PROJECT_NAME}\0${APP_ID}\0${getOsMachineId()}`, 'utf-8')
    .digest('hex');
  return `${CLIENT_ID_VERSION}-${digest}`;
}

module.exports = {
  createAnalyticsClientId,
  getOsMachineId,
};
