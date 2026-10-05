import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react-swc';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { VitePWA } from 'vite-plugin-pwa';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Dev-only: serve the bundled dictionary `*.gz` files (kuromoji + JMdict buckets) as raw bytes.
 *
 * Vite's dev static server tags `.gz` responses with `Content-Encoding: gzip`, so the
 * browser transparently inflates them and the kuromoji loader receives already-decompressed
 * bytes — its own gunzip step then throws "invalid gzip data". Serving them ourselves with
 * `application/octet-stream` and no `Content-Encoding` keeps the raw gzip bytes intact, matching
 * how the Android app and static hosts serve them. `configureServer` only runs during `vite dev`.
 */
function serveRawGzipDict(): PluginOption {
  return {
    name: 'serve-raw-gzip-dict',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (!/^\/dict\/.*\.gz$/.test(url)) return next();
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
 * cross-origin isolated.
 */
const COI_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

/** `npm run build:android` — the Capacitor WebView build, which has no use for a service worker. */
const ANDROID = process.env.GAKUTAKU_TARGET === 'android';

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
    !ANDROID &&
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        // Keep large runtime assets out of the precache manifest: the SQLite WASM, the bundled
        // dictionaries (kuromoji + JMdict buckets) and the font subsets, all cached as first used.
        globIgnores: ['**/*.wasm', 'dict/**'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          {
            // SQLite + optimizer WASM.
            urlPattern: /\.(?:wasm)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'wasm',
              expiration: { maxEntries: 8 },
            },
          },
          {
            // Kuromoji IPADIC — cache on first tokenize for offline use.
            urlPattern: /\/dict\/kuromoji\/.*\.dat\.gz$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'kuromoji-dict',
              expiration: { maxEntries: 16 },
            },
          },
          {
            // Bundled font subsets (Japanese fonts are split into ~100 unicode-range files each).
            urlPattern: /\.woff2?$/,
            handler: 'CacheFirst',
            options: { cacheName: 'fonts', expiration: { maxEntries: 600 } },
          },
          {
            // JMdict buckets + manifest — cache each one as it is looked up.
            urlPattern: /\/dict\/jmdict\//,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'jmdict', expiration: { maxEntries: 5000 } },
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
    // These must not be pre-bundled (they load their own wasm / spawn workers relative to
    // themselves): SQLite and the fsrs-browser optimizer (wasm-bindgen-rayon).
    exclude: ['@sqlite.org/sqlite-wasm', 'fsrs-browser'],
    include: ['epubjs'],
  },
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
});
