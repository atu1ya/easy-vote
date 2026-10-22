import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Served from https://<user>.github.io/easy-vote/, so assets must be
  // requested from that sub-path rather than the domain root.
  base: '/easy-vote/',
  plugins: [react()],
  server: {
    // Honour a port assigned by the environment so the dev server does not
    // silently land on a different port than the tooling expects.
    port: Number(process.env.PORT) || 5173,
  },
});