/** 共享配图布局份额模块的类型声明（供渲染进程 TS 使用）。 */

export type ImageLayoutKey = 'single' | 'imageText' | 'threeImages' | 'fourImages';

export type ImageLayoutOptionKey = 'useSingleImageLayout' | 'useImageTextLayout' | 'useThreeImagesLayout' | 'useFourImagesLayout';

export type ImageLayoutShares = Record<ImageLayoutKey, number>;

export interface ImageLayoutOptions {
  imageQuantity: number;
  useSingleImageLayout?: boolean;
  useImageTextLayout?: boolean;
  useThreeImagesLayout?: boolean;
  useFourImagesLayout?: boolean;
}

export const IMAGE_LAYOUTS: ReadonlyArray<Readonly<{ key: ImageLayoutKey; optionKey: ImageLayoutOptionKey }>>;

export function getDefaultImageLayoutShares(imageQuantity: number): ImageLayoutShares;

export function resolveImageLayoutShares(options: ImageLayoutOptions): ImageLayoutShares;

export function allocateImageLayoutGroups(total: number, shares: ImageLayoutShares): ImageLayoutShares;
