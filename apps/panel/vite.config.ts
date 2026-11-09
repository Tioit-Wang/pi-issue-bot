import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/**
 * 面板的 Vite 配置（tech-plan §9.1：Vite SPA，无 SSR，无 Tailwind 配置文件）。
 *
 * - `@tailwindcss/vite`：Tailwind 4 的官方插件，CSS 里 `@import "tailwindcss"` 即生效；
 * - dev 代理把 `/api/*` 转发到本地 server（`127.0.0.1:3000`），所以面板代码里只写相对路径；
 * - 构建产物 `dist/` 由 server 的 `@fastify/static` 托管（部署面在 W3-L）。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
