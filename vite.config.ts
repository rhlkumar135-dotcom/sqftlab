// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import path from 'path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tsConfigPaths from 'vite-tsconfig-paths'

// The runtime builds with an absolute `--base /p/<projectId>/`, so index.html
// ends up referencing `/p/<id>/assets/index-*.js`. The static publish host serves
// assets from the site root, and that prefixed path matches no file — it falls
// through to the SPA fallback and returns index.html for a JS module, so the
// bundle never executes and the page renders blank. Rewriting to relative paths
// resolves correctly both at `/` (published) and at `/p/<id>/` (canvas preview).
function relativeAssetBase(): Plugin {
  return {
    name: 'sqftlab-relative-asset-base',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/(src|href)="\/p\/[^/]+\/assets\//g, '$1="./assets/')
    },
  }
}

export default defineConfig({
  base: './',
  server: {
    port: 3000,
    host: '0.0.0.0',
    cors: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
    watch: {
      ignored: ['**/.shogo/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  plugins: [
    tsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    react(),
    relativeAssetBase(),
  ],
  build: {
    target: 'esnext',
    minify: false,
  },
})
