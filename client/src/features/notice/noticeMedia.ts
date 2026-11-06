import type { NoticeMedia } from '../../shared/types/notice';

export interface PreparedNoticeMedia {
  element: HTMLImageElement | HTMLVideoElement;
  dispose: () => void;
}

/** 加载实际展示节点，图片解码／视频首帧就绪前不创建可见弹窗。 */
export function prepareNoticeMedia(kind: NoticeMedia['kind'], url: string, signal: AbortSignal): Promise<PreparedNoticeMedia> {
  return new Promise((resolve, reject) => {
    const element = kind === 'image' ? new Image() : document.createElement('video');
    let settled = false;

    /** 释放媒体数据，视频在后台不继续播放。 */
    const dispose = () => {
      if (element instanceof HTMLVideoElement) element.pause();
      element.removeAttribute('src');
      if (element instanceof HTMLVideoElement) element.load();
    };
    /** 结束准备后移除临时事件监听。 */
    const removeListeners = () => {
      element.removeEventListener('load', onReady);
      element.removeEventListener('loadeddata', onReady);
      element.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    /** 失败与取消均释放节点，不产生已读或送达状态。 */
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      removeListeners();
      dispose();
      reject(error);
    };
    /** 图片需解码完成；视频 loadeddata 表示首帧数据可用。 */
    const onReady = async () => {
      try {
        if (element instanceof HTMLImageElement) await element.decode();
        if (settled) return;
        signal.throwIfAborted();
        settled = true;
        removeListeners();
        resolve({ element, dispose });
      } catch (error) {
        fail(error instanceof Error ? error : new Error('公告媒体解码失败'));
      }
    };
    const onError = () => fail(new Error('公告媒体加载或解码失败'));
    const onAbort = () => fail(new DOMException('公告媒体准备已取消', 'AbortError'));

    if (signal.aborted) { onAbort(); return; }
    if (element instanceof HTMLVideoElement) {
      element.preload = 'auto';
      element.muted = true;
      element.playsInline = true;
      element.controls = true;
      element.addEventListener('loadeddata', onReady);
    } else {
      element.addEventListener('load', onReady);
    }
    element.addEventListener('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    element.src = url;
  });
}
