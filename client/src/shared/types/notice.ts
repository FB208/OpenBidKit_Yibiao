/** 图片公告的媒体、跳转和关闭配置；视频同属图片公告。 */
export interface NoticeMedia {
  kind: 'image' | 'video';
  url: string;
  linkUrl: string;
  closeDelaySeconds: number;
  openLinkOnClose: boolean;
}

/** 公共正文始终保留 Markdown，供旧客户端读取。 */
export type NoticePresentation = {
  title: string;
  content: string;
} & (
  | { noticeType: 'text'; media: null }
  | { noticeType: 'image'; media: NoticeMedia }
);

export interface NoticeMediaCacheRequest {
  projectName: string;
  noticeId: string;
  media: NoticeMedia;
}

export interface NoticeCachedMedia {
  url: string;
  leaseId: string;
}
