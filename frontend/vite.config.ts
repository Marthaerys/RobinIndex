import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// Served from https://robinindex.com/ (custom domain, root path) via GitHub
// Pages — base is "/" because the site now lives at the domain root, not
// under a /RobinIndex/ subpath. See public/CNAME for the other half of the
// custom-domain setup.
export default defineConfig({
  base: "/",
  plugins: [react()],
})
