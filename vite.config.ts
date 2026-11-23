import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The three windows' pages. Electron serves dist/ from toru://app/ (see electron/main.ts).
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome130',
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        index: r('./index.html'),
        recorder: r('./recorder.html'),
        widget: r('./widget.html'),
      },
      output: {
        manualChunks: (id) => (/node_modules[\/](react|react-dom|scheduler)[\/]/.test(id) ? 'react' : undefined),
      },
    },
  },
});
