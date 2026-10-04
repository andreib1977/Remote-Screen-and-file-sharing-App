import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Electron loads the built renderer from disk (file://), so every asset URL must
// be relative and the output directory must be fixed.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome124',
    sourcemap: false,
    chunkSizeWarningLimit: 2048
  },
  server: {
    port: 5273,
    strictPort: true
  }
});
