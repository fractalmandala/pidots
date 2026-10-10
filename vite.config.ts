/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { darkTheme } from './src/build/dark-theme';
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as {
  version: string;
};
export default defineConfig({
  plugins: [react()],
  // The app version, bumped by every desktop build.
  define: { __APP_VERSION__: JSON.stringify(version) },
  css: { postcss: { plugins: [darkTheme()] } },
  build: { outDir: 'dist/client' },
  test: { include: ['tests/**/*.test.{ts,tsx,js}'] },
  server: {
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:4310' },
  },
});
