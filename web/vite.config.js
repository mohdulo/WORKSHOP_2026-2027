import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// En dev, Vite (5173) relaie l'API vers le serveur PaySim (4000). En production, le serveur sert web/dist lui-même.
const target = process.env.PAYSIM_API || 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/v1': { target, changeOrigin: false },
      '/demo': { target, changeOrigin: false },
      '/health': { target, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
