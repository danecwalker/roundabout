import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const target = 'http://localhost:8790';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  base: '/',
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': target,
      '/v1': target,
      '/widget': target,
    },
  },
  build: { outDir: 'dist' },
});
