// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import path from 'path'
import { execSync } from 'child_process'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tsConfigPaths from 'vite-tsconfig-paths'

// Stamps every built index.html with which revision it came from.
//
// Without this there was no way to tell a stale deployment from a cached page
// from a mispointed domain: every candidate looks like "the site is old". With
// the stamp, View Source on the live site answers it directly — a missing or
// old build-time means the host is not serving this build.
//
// RAILWAY_GIT_COMMIT_SHA is set by Railway at build time. The Docker build
// excludes .git, so the git fallback only works for local builds.
function buildIdentity(): Plugin {
  let sha = process.env.RAILWAY_GIT_COMMIT_SHA || ''
  if (!sha) {
    try {
      sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
    } catch {
      sha = ''
    }
  }
  const stamp = new Date().toISOString()
  return {
    name: 'sqftlab-build-identity',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(
        '</head>',
        `    <meta name="build-sha" content="${sha || 'unknown'}" />\n` +
          `    <meta name="build-time" content="${stamp}" />\n` +
          `  </head>`,
      )
    },
  }
}

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
    buildIdentity(),
  ],
  build: {
    target: 'esnext',
    minify: false,
  },
})
