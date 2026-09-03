import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// Served from https://marthaerys.github.io/RobinIndex/ via GitHub Pages —
// base must match the repo name so built asset URLs resolve correctly.
export default defineConfig({
  base: "/RobinIndex/",
  plugins: [react()],
})
