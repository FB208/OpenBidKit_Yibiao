import type { ToastOptions, ToastType } from './ui';

type ShowToast = (message: string, type?: ToastType, options?: ToastOptions) => number;

let promptedUpdateVersion = '';

export function hasPromptedUpdate(version: string) {
  return Boolean(version) && promptedUpdateVersion === version;
}

export function showUpdateReadyToast(showToast: ShowToast, version: string) {
  if (version) {
    promptedUpdateVersion = version;
  }

  const installUpdate = async () => {
    const result = await window.yibiao?.quitAndInstall();
    if (result && !result.success) {
      showToast(result.message || '安装更新失败', 'error');
    }
  };

  const versionText = version ? `新版本 ${version}` : '新版本';
  showToast(`${versionText} 已下载完成，可重启应用安装。`, 'info', {
    title: '更新已准备好',
    persistent: true,
    actions: [
      {
        label: '安装并重启',
        variant: 'primary',
        close: false,
        onClick: installUpdate,
      },
      { label: '稍后' },
    ],
  });
}
