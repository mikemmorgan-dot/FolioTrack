import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{js,jsx}'],
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
