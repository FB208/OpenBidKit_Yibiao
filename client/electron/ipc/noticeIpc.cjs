const { ipcMain } = require('electron');

/** 注册公告缓存通道，并在 Renderer 离开时释放媒体占用。 */
function registerNoticeIpc({ noticeMediaCacheService }) {
  const boundSenders = new Set();

  /** 每个 Renderer 只绑定一次生命周期，不在窗口重载后遗留占用。 */
  function bindSender(sender) {
    if (boundSenders.has(sender.id)) return;
    const ownerId = sender.id;
    boundSenders.add(ownerId);
    sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) noticeMediaCacheService.releaseOwner(ownerId);
    });
    sender.once('destroyed', () => {
      boundSenders.delete(ownerId);
      noticeMediaCacheService.releaseOwner(ownerId);
    });
  }

  ipcMain.handle('notice:sync-current', (_event, request) => noticeMediaCacheService.syncCurrent(request));
  ipcMain.handle('notice:prepare-media', (event, request) => {
    bindSender(event.sender);
    return noticeMediaCacheService.prepareMedia(request, event.sender.id);
  });
  ipcMain.handle('notice:release-media', (_event, leaseId) => noticeMediaCacheService.releaseMedia(leaseId));
}

module.exports = { registerNoticeIpc };
