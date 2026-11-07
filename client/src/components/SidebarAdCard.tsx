import { useEffect, useState } from 'react';
import { trackAdClick } from '../shared/analytics/analytics';

const ADS_ENDPOINT = 'https://analytics.agnet.top/ads';
const ROTATE_INTERVAL_MS = 8000;

interface SidebarAd {
  id: string;
  linkUrl: string;
  imageUrl: string;
}

interface SidebarAdCardProps {
  collapsed: boolean;
}

// 图片预加载成功的广告才进入轮播，避免坏图或慢图闪现占位。
function preloadImage(url: string) {
  return new Promise<boolean>((resolve) => {
    const image = new Image();
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = url;
  });
}

function SidebarAdCard({ collapsed }: SidebarAdCardProps) {
  const [ads, setAds] = useState<SidebarAd[]>([]);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let active = true;

    void fetch(ADS_ENDPOINT)
      .then((response) => (response.ok ? response.json() : null))
      .then(async (data) => {
        const raw: Array<Partial<SidebarAd>> = Array.isArray(data?.ads) ? data.ads : [];
        const list: SidebarAd[] = raw
          .map((ad) => ({
            id: String(ad?.id || ''),
            linkUrl: String(ad?.linkUrl || ''),
            imageUrl: String(ad?.imageUrl || ''),
          }))
          .filter((ad) => Boolean(ad.id && ad.linkUrl && ad.imageUrl));

        const loaded = await Promise.all(
          list.map(async (ad) => ((await preloadImage(ad.imageUrl)) ? ad : null)),
        );
        if (active) setAds(loaded.filter((ad): ad is SidebarAd => Boolean(ad)));
      })
      .catch(() => undefined);

    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (dismissed || paused || ads.length < 2) return;

    const timer = window.setInterval(() => {
      setIndex((value) => (value + 1) % ads.length);
    }, ROTATE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [ads.length, dismissed, paused]);

  if (collapsed || dismissed || !ads.length) return null;

  const ad = ads[index % ads.length];

  const openAd = () => {
    trackAdClick(ad.id);
    if (window.yibiao?.openExternal) {
      void window.yibiao.openExternal(ad.linkUrl);
      return;
    }
    window.open(ad.linkUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div
      className="sidebar-ad"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <button type="button" className="sidebar-ad-media" onClick={openAd} aria-label="打开广告链接">
        <img key={ad.id} src={ad.imageUrl} alt="" />
      </button>
      {ads.length > 1 ? (
        <div className="sidebar-ad-dots" aria-hidden="true">
          {ads.map((item, dotIndex) => (
            <span key={item.id} className={dotIndex === index % ads.length ? 'is-active' : ''} />
          ))}
        </div>
      ) : null}
      <button
        type="button"
        className="sidebar-ad-close"
        onClick={() => setDismissed(true)}
        aria-label="关闭广告"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

export default SidebarAdCard;
