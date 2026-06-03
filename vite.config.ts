import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    wasm(),
    topLevelAwait(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // PowerSync ships large WASM + worker assets that are loaded at runtime.
      // Keep them out of the precache manifest and serve them via a runtime cache.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        globIgnores: ['**/*.wasm', '**/sqlite3*.js', '**/*worker*.js'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          {
            // wa-sqlite WASM + PowerSync worker bundles.
            urlPattern: /\.(?:wasm)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'powersync-wasm',
              expiration: { maxEntries: 8 },
            },
          },
        ],
      },
      manifest: {
        name: 'GakuTaku',
        short_name: 'GakuTaku',
        description: 'Immersion reading & spaced-repetition study for Japanese.',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  optimizeDeps: {
    // PowerSync web SDK must not be pre-bundled (it relies on workers + wasm).
    exclude: ['@powersync/web', '@journeyapps/wa-sqlite'],
    include: ['@powersync/react'],
  },
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
});
