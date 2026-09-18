import assert from 'node:assert/strict';
import test from 'node:test';
import { SYSTEM_GROUP_CHAT_QR_KEY } from '../constants.js';
import { handleAdminSystemSettings, handlePublicSystemSettings } from './systemSettings.js';

test('系统二维码未配置时为空，上传后返回带版本的图片地址', async () => {
  const objects = new Map();
  const env = {
    ADMIN_TOKEN: 'test-token',
    RESOURCE_BUCKET: {
      head: async (key) => objects.get(key) || null,
      put: async (key, body, options) => objects.set(key, {
        body,
        httpEtag: 'test-etag',
        httpMetadata: options.httpMetadata,
      }),
    },
  };
  const url = new URL('https://analytics.example/system-settings');

  const emptyResponse = await handlePublicSystemSettings(new Request(url), env, url);
  assert.equal((await emptyResponse.json()).settings.groupChatQrUrl, '');

  const formData = new FormData();
  formData.append('image', new Blob(['qr'], { type: 'image/png' }), 'group.png');
  const uploadRequest = new Request('https://analytics.example/api/system-settings', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token' },
    body: formData,
  });
  const uploadResponse = await handleAdminSystemSettings(uploadRequest, env, new URL(uploadRequest.url));
  assert.equal(uploadResponse.status, 200);
  assert.equal(objects.get(SYSTEM_GROUP_CHAT_QR_KEY).httpMetadata.contentType, 'image/png');

  const configuredResponse = await handlePublicSystemSettings(new Request(url), env, url);
  assert.match((await configuredResponse.json()).settings.groupChatQrUrl, /resource-image\?key=.*&v=test-etag$/);
});
