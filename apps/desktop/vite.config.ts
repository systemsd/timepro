import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri uses a fixed port for hot-reload; we let it pick host/port via env.
// See https://tauri.app/v2/guides/start/cli for the contract.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      // Tauri rebuilds Rust on its own; don't trigger vite reloads from src-tauri.
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
});
