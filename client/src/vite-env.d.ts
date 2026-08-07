/// <reference types="vite/client" />

import type { YibiaoBridge } from './shared/types';

declare global {
  interface Window {
    yibiao: YibiaoBridge;
    yibiaoClient?: {
      appName: string;
      platform: string;
    };
  }
}

export {};
