import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'frontend',
  server: {
    port: 3000,
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
