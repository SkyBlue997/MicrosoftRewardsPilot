#!/usr/bin/env node
/**
 * ensure-browser.js - portable Playwright browser bootstrap for this project.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `npm start` runs the compiled bot from dist/, which launches Chromium through
 * rebrowser-playwright. Browser binaries are NOT part of node_modules and are NOT inside this
 * project folder: they live in a per-user cache
 *   Windows : %LOCALAPPDATA%\ms-playwright
 *   Linux   : ~/.cache/ms-playwright
 *   macOS   : ~/Library/Caches/ms-playwright
 * and they must be downloaded once per machine, at the exact revision the installed Playwright
 * version expects (rebrowser-playwright-core 1.52.0 -> chromium-1169 / Chromium 136.0.7103.25).
 *
 * Copying/cloning this folder to another computer does NOT move that cache, so a fresh machine
 * fails at launch with:
 *   browserType.launch: Executable doesn't exist at
 *   ...\ms-playwright\chromium-1169\chrome-win\chrome.exe
 *
 * Playwright's own message tells you to run `npx playwright install`. In THIS project that command
 * is not dependable: `node_modules/.bin/playwright` is claimed by two packages at once
 * (rebrowser-playwright and playwright both declare the bin name "playwright"), so which CLI
 * actually runs depends on install order. rebrowser-playwright's CLI hard-codes
 * require.resolve("playwright/lib/transform/esmLoader"), which throws MODULE_NOT_FOUND in an
 * install that has no package named `playwright` (for example `npm ci --omit=dev`) - the download
 * never starts. This script therefore bypasses npx/.bin entirely and drives the bundled
 * playwright-core CLI (node_modules/playwright-core/cli.js) directly; that entry point contains no
 * such hard-coded reference.
 *
 * USAGE
 * -----
 *   node scripts/ensure-browser.js        # check, and download only if missing
 * Wired into: `pre-build` (fresh install), `setup`, and `prestart` (so `npm start` self-heals
 * after the folder is copied to a new machine).
 *
 * Relevant environment variables:
 *   PLAYWRIGHT_DOWNLOAD_HOST          optional download mirror/CDN override
 *                                     (CN mirror: https://cdn.npmmirror.com/binaries/playwright)
 *   PLAYWRIGHT_BROWSERS_PATH          optional alternative browser cache root
 *   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD  if set (any non-empty value) this script refuses to download,
 *                                     for CI / offline images that pre-bake the cache
 *
 * Exit codes: 0 = browser present (or installed), 1 = missing and could not be installed.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const TAG = '[ensure-browser]'
const log = (msg) => console.log(`${TAG} ${msg}`)
const fail = (msg) => {
    console.error(`${TAG} ${msg}`)
    process.exit(1)
}

let chromium
try {
    ({ chromium } = require('rebrowser-playwright'))
} catch (err) {
    console.error(`${TAG} cannot load rebrowser-playwright: ${err.message}`)
    fail('dependencies are missing - run: npm install')
}

// Resolves to the browser this exact Playwright build wants (e.g. ...\chromium-1169\...\chrome.exe)
const executable = chromium.executablePath()

if (fs.existsSync(executable)) {
    log(`ok: ${executable}`)
    process.exit(0)
}

if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD) {
    console.error(`${TAG} Chromium is missing: ${executable}`)
    fail('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set, so no download was attempted. Unset it and re-run.')
}

let coreCli
try {
    coreCli = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js')
} catch (err) {
    fail(`cannot locate playwright-core: ${err.message} - run: npm install`)
}

log(`Chromium missing at ${executable}`)
log('downloading it now (first run on this machine only, ~230 MB, needs internet)...')
if (process.env.PLAYWRIGHT_DOWNLOAD_HOST) log(`download host override: ${process.env.PLAYWRIGHT_DOWNLOAD_HOST}`)

// stdio: 'inherit' keeps Playwright's own progress bar visible and avoids any piped-stdio issues.
const result = spawnSync(process.execPath, [coreCli, 'install', 'chromium'], { stdio: 'inherit' })

if (result.error) fail(`could not start the installer: ${result.error.message}`)
if (result.status !== 0) {
    console.error(`${TAG} installer exited with code ${result.status}`)
    console.error(`${TAG} retry manually, e.g.:`)
    console.error('  node node_modules/playwright-core/cli.js install chromium')
    console.error('  # slow/blocked network, use the CN mirror:')
    console.error('  PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright \\')
    console.error('    node node_modules/playwright-core/cli.js install chromium')
    process.exit(1)
}
if (!fs.existsSync(executable)) fail(`installer reported success but ${executable} is still missing`)

log(`ok: ${executable}`)
