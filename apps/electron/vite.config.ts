import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@/types': resolve(__dirname, 'src/types'),
      '@': resolve(__dirname, 'src/renderer'),
    },
  },
  server: {
    // 使用 5174 避免与 proma-ext（主 fork）的 dev server（5173）冲突，
    // 使两个 Proma 开发实例可以同时运行。
    port: 5174,
    strictPort: true, // 确保使用指定端口，如被占用则报错
    open: false,
  },
})
