/**
 * rebrowser-playwright anti-detection patches — runtime switches.
 *
 * The project depends on rebrowser-playwright (a pre-patched Playwright) to neutralise the
 * `Runtime.enable` CDP leak that vanilla Playwright exposes (a main-world execution context + the
 * detectable `__playwright_utility_world__`). In the installed core the patch is opt-OUT — it runs
 * unless a switch is explicitly set to '0' — so we set these defaults to pin it ON and stable across
 * version bumps (older rebrowser builds defaulted to a no-op "alert" mode). An explicit value from
 * the shell / .env / docker-compose still wins.
 *
 * Imported FIRST in src/index.ts, before rebrowser-playwright loads.
 * Verify with https://bot-detector.rebrowser.net/
 */
const REBROWSER_PATCH_DEFAULTS: Record<string, string> = {
    // 'addBinding' = obtain the isolated-world context via Runtime.addBinding (no main-world Runtime.enable).
    REBROWSER_PATCHES_RUNTIME_FIX_MODE: 'addBinding',
    // Rename the utility world off the tell-tale '__playwright_utility_world__' default.
    REBROWSER_PATCHES_UTILITY_WORLD_NAME: 'util'
}

for (const [key, value] of Object.entries(REBROWSER_PATCH_DEFAULTS)) {
    if (!process.env[key]) {
        process.env[key] = value
    }
}

export {}
