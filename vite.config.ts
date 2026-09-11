import { defineConfig } from 'vite';
export default defineConfig({
  root: 'src/client',
  build: { outDir: '../../dist/client', emptyOutDir: true },
});
