import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4321', '/feeds': 'http://127.0.0.1:4321' } },
  build: {
    outDir: 'dist',
    // The message catalogs change with the text, not the code: keep them in their own cached chunk.
    rollupOptions: { output: { manualChunks: id => id.includes('/src/shared/locales/') ? 'locales' : undefined } },
  },
});
