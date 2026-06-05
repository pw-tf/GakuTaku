import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react-swc';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { VitePWA } from 'vite-plugin-pwa';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Dev-only: serve the vendored kuromoji `*.dat.gz` dictionary files as raw bytes.
 *
 * Vite's dev static server tags `.gz` responses with `Content-Encoding: gzip`, so the
 * browser transparently inflates them and the kuromoji loader receives already-decompressed
 * bytes — its own gunzip step then throws "invalid gzip data". Serving them ourselves with
 * `application/octet-stream` and no `Content-Encoding` keeps the raw gzip bytes intact, matching
 * how Cloudflare Pages serves them in production. `configureServer` only runs during `vite dev`.
 */
function serveRawGzipDict(): PluginOption {
  return {
    name: 'serve-raw-gzip-dict',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (!/^\/dict\/.*\.dat\.gz$/.test(url)) return next();
        const publicDir = server.config.publicDir;
        const filePath = path.join(publicDir, decodeURIComponent(url));
        // Guard against path traversal escaping the public dir.
        if (!path.resolve(filePath).startsWith(path.resolve(publicDir))) return next();
        readFile(filePath)
          .then((buf) => {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', buf.length);
            res.end(buf);
          })
          .catch(() => next());
      });
    },
  };
}

/**
 * Cross-origin isolation headers. The FSRS optimizer (fsrs-browser → wasm-bindgen-rayon) trains on
 * a `SharedArrayBuffer` across worker threads, which the browser only exposes when the document is
 * cross-origin isolated. We use `credentialless` (not `require-corp`) so the app's cross-origin
 * subresources — Google Fonts and Supabase Storage — keep loading without per-resource CORP headers.
 */
const COI_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

// https://vite.dev/config/
export default defineConfig({
  // Ignore the gitignored sample-ePUB handoff folder: locked .epub files there crash the file watcher.
  server: { headers: COI_HEADERS, watch: { ignored: ['**/design_handoff_gakutaku/**'] } },
  preview: { headers: COI_HEADERS },
  plugins: [
    serveRawGzipDict(),
    wasm(),
    topLevelAwait(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // PowerSync ships large WASM + worker assets that are loaded at runtime.
      // Keep them out of the precache manifest and serve them via a runtime cache.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // Keep large runtime assets out of the precache manifest: PowerSync WASM/workers
        // and the vendored kuromoji dictionary (~17 MB of .dat.gz).
        globIgnores: ['**/*.wasm', '**/sqlite3*.js', '**/*worker*.js', 'dict/**'],
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
          {
            // Vendored kuromoji IPADIC dictionary — cache on first tokenize for offline use.
            urlPattern: /\/dict\/kuromoji\/.*\.dat\.gz$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'kuromoji-dict',
              expiration: { maxEntries: 16 },
            },
          },
          {
            // Google Fonts stylesheets.
            urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-stylesheets' },
          },
          {
            // Google Fonts webfont files — keep offline for a year.
            urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
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
    // These must not be pre-bundled (they rely on workers + wasm): PowerSync web SDK and the
    // fsrs-browser optimizer (wasm-bindgen-rayon self-spawns module workers).
    exclude: ['@powersync/web', '@journeyapps/wa-sqlite', 'fsrs-browser'],
    include: ['@powersync/react', 'epubjs'],
  },
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
});
