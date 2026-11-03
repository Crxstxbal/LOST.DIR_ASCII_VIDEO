import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { lostdirApi } from './src/server/vitePluginApi';

export default defineConfig({
  plugins: [react(), lostdirApi()],
  server: { port: 5178, open: false },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
  },
} as any);
