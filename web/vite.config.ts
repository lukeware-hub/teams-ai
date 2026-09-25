import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@server': path.resolve(__dirname, '../server') } },
  server: { port: 5173, proxy: { '/api': { target: `http://127.0.0.1:${process.env.TEAMS_AI_API_PORT ?? '8787'}`, changeOrigin: false } } },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], include: ['src/**/*.test.{ts,tsx}'] },
});
