import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: { globals: true, environment: 'node', include: ['test/**/*.test.ts'] },
});
