const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// 使用实际更新服务，以替代网络和下载的方式验证完整入口，不写安装包。
function createHarness({ releases = [], channel = 'atomgit', platform = 'win32', updateInfo, isUpdateAvailable = true } = {}) {
  const requests = [];
  const downloads = [];
  const errors = [];
  const updater = new EventEmitter();
  updater.setFeedURL = (feed) => { updater.feed = feed; };
  updater.checkForUpdates = async () => ({ isUpdateAvailable, updateInfo: updateInfo || { version: '2.26.1' } });
  updater.downloadUpdate = async () => { downloads.push('electron-updater'); };
  const context = {
    require: (name) => name === 'electron-updater' ? { autoUpdater: updater } : require(name),
    module: { exports: {} }, console,
    process: { platform, arch: 'x64' },
    requestStub: async (url) => {
      requests.push(url);
      if (channel === 'atomgit') {
        assert.ok(url.startsWith('https://api.atomgit.com/'));
        assert.ok(!url.includes('/latest'));
        const page = Number(new URL(url).searchParams.get('page'));
        return releases.slice((page - 1) * 100, page * 100);
      }
      assert.ok(url.startsWith(channel === 'github' ? 'https://api.github.com/' : 'https://openbidkit-oss.agnet.top/'));
      return releases[0];
    },
    downloadStub: async (url) => { downloads.push(url); },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'updateService.cjs'), 'utf-8')
      + '\nrequestJson = requestStub; downloadFile = downloadStub;',
    context,
  );
  const service = context.module.exports;
  const options = {
    app: { isPackaged: true, getVersion: () => '2.25.27', getPath: () => path.join(__dirname, '__update_test_no_files__') },
    configStore: { load: () => ({ update_channel: channel }) },
    onError: (message) => errors.push(message),
  };
  service.setupAutoUpdate(options);
  return { service, options, requests, downloads, errors, updater };
}

// 构造三个源各自使用的版本与附件字段。
function release(version, extra = {}) {
  const file = { name: `Yibiao-${version}-win-x64.exe`, url: `https://example.com/${version}.exe` };
  const macFile = { name: `Yibiao-${version}-mac-x64.dmg`, url: `https://example.com/${version}.dmg` };
  return {
    version, tag_name: `v${version}`, tagName: `v${version}`,
    assets: [file, macFile].map((asset) => ({ ...asset, browser_download_url: asset.url })),
    files: [file, macFile], ...extra,
  };
}

test('三个源在 Windows 和 macOS 均排除测试版与草稿，所有入口不返回测试安装包', async () => {
  const excluded = [
    release('2.26.1-alpha.1'), release('2.26.1-beta.2'), release('2.26.1-rc.1'),
    release('2.26.1', { prerelease: true }), release('2.26.1', { isPrerelease: true }),
    release('2.26.1', { draft: true }), release('2.26.1', { isDraft: true }),
    release('2.26.1', { release_status: 'pre' }), release('2.26.1', { release_status: 'draft' }),
  ];
  for (const channel of ['github', 'cloudflare', 'atomgit']) {
    for (const platform of ['win32', 'darwin']) {
      for (const candidate of excluded) {
        const h = createHarness({ channel, platform, releases: [candidate] });
        assert.equal((await h.service.getLatestVersion(h.options)).version, '');
        assert.ok(!(await h.service.getUpdateDownloadUrl(h.options)).includes('2.26.1'));
        for (const method of ['checkAndDownloadUpdate', 'triggerUpdateDownload']) {
          assert.equal((await h.service[method](h.options)).updateAvailable, false);
        }
        assert.equal(h.downloads.length, 0);
        assert.equal(h.errors.length, 0);
      }
    }
  }
});

test('AtomGit 遍历所有分页并按版本比较选择正式版，不依赖列表顺序', async () => {
  const releases = Array.from({ length: 100 }, () => release('2.27.0-alpha.1'));
  releases.push(release('2.26.9'), release('2.26.11'), release('2.26.2'), release('2.28.0', { prerelease: true }));
  const h = createHarness({ releases });
  assert.equal((await h.service.getLatestVersion(h.options)).version, '2.26.11');
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests[1].includes('page=2'));
  assert.ok((await h.service.getUpdateDownloadUrl(h.options)).includes('v2.26.11/attach_files/'));
});

test('复现线上 AtomGit 测试版仅有源码包的场景，当前正式版不报缺少安装包', async () => {
  const h = createHarness({ releases: [release('2.25.27'), release('2.26.1-alpha.1', { prerelease: true, assets: [{ name: 'source.zip' }] })] });
  const result = await h.service.checkAndDownloadUpdate(h.options);
  assert.equal(result.updateAvailable, false);
  assert.equal(h.errors.length, 0);
  assert.equal(h.downloads.length, 0);
});

test('三个源的新正式版进入对应下载流程，相同或更旧版本不下载', async () => {
  for (const channel of ['github', 'cloudflare', 'atomgit']) {
    for (const platform of ['win32', 'darwin']) {
      for (const version of ['2.25.26', '2.25.27', '2.26.1']) {
        const h = createHarness({ channel, platform, releases: [release(version)] });
        const result = await h.service.checkAndDownloadUpdate(h.options);
        assert.equal(result.channel, channel);
        assert.equal(result.updateAvailable, version === '2.26.1');
        assert.equal(h.downloads.length, version === '2.26.1' ? 1 : 0);
        assert.equal(h.errors.length, 0);
        if (version === '2.26.1') {
          assert.equal(result.downloaded, true);
          if (platform === 'win32' && channel !== 'atomgit') {
            assert.equal(h.updater.feed.provider, channel === 'github' ? 'github' : 'generic');
          } else {
            assert.ok(h.downloads[0].includes(platform === 'win32' ? '.exe' : '.dmg'));
          }
        }
      }
    }
  }
});

test('更新组件再次读取的清单也必须是更新的正式版，才允许下载', async () => {
  for (const channel of ['github', 'cloudflare']) {
    for (const version of ['2.26.1-alpha.1', '2.25.27', '2.25.26']) {
      const h = createHarness({ channel, releases: [release('2.26.1')], updateInfo: { version } });
      assert.equal((await h.service.checkAndDownloadUpdate(h.options)).updateAvailable, false);
      assert.equal(h.downloads.length, 0);
    }
    const h = createHarness({ channel, releases: [release('2.26.1')], isUpdateAvailable: false });
    assert.equal((await h.service.checkAndDownloadUpdate(h.options)).updateAvailable, false);
    assert.equal(h.downloads.length, 0);
  }
});

test('设置页重新载入时保留 GitHub 更新源选择', () => {
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(__dirname, '../../src/features/settings/pages/SettingsPage.tsx'), 'utf-8');
  const ast = ts.createSourceFile('SettingsPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = ast.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'normalizeUpdateChannel');
  const context = {};
  vm.runInNewContext(ts.transpileModule(declaration.getText(ast), {}).outputText, context);
  for (const channel of ['github', 'cloudflare', 'atomgit']) {
    assert.equal(context.normalizeUpdateChannel(channel), channel);
  }
});
