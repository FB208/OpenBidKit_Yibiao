import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  // 隐藏工作窗口才会用到 pdfjs，开发服务器启动时就预先处理，
  // 否则首次用到时会重新处理依赖并刷新页面，打断正在加载的工作窗口。
  optimizeDeps: {
    include: ['pdfjs-dist/legacy/build/pdf.mjs'],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: {
      allow: ['.'],
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
