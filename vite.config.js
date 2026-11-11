import base44 from "@base44/vite-plugin"
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // `vite build --mode desktop` is the offline Electron build: no Base44
  // plugin (analytics, editor hooks, backend), output in dist/.
  // `desktop-public` is the same build without the owner-only tools: the
  // installer offered on the artist's website (src/lib/edition.js).
  if (mode === 'desktop' || mode === 'desktop-public') {
    return {
      plugins: [react()],
      define: { 'import.meta.env.VITE_EDITION': JSON.stringify(mode === 'desktop-public' ? 'public' : 'full') },
      resolve: {
        alias: [
          // Public build: the owner-only modules become an empty stub.
          ...(mode === 'desktop-public'
            ? ['OwnerPanels', 'BloopersGate', 'BloopersPanel', 'ProducePanel'].map((name) => ({
                find: `@/components/studio/${name}`,
                replacement: fileURLToPath(new URL('./src/components/studio/OwnerStub.jsx', import.meta.url)),
              }))
            : []),
          { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
        ],
      },
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
