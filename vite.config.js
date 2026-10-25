import base44 from "@base44/vite-plugin"
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // `vite build --mode desktop` is the offline Electron build: no Base44
  // plugin (analytics, editor hooks, backend), output in dist/.
  if (mode === 'desktop') {
    return {
      plugins: [react()],
      resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    }
  }
  return {
    plugins: [
      base44({
        // Support for legacy code that imports the base44 SDK with @/integrations, @/entities, etc.
        // can be removed if the code has been updated to use the new SDK imports from @base44/sdk
        legacySDKImports: process.env.BASE44_LEGACY_SDK_IMPORTS === 'true',
        hmrNotifier: true,
        navigationNotifier: true,
        analyticsTracker: true,
        visualEditAgent: true
      }),
      react(),
    ]
  }
});
