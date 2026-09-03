/**
 * shiny.cov-playwright — Playwright fixtures
 *
 * The `test`/`expect` this package's consumers should import instead of
 * `@playwright/test`'s own. Overrides the built-in `page` fixture with
 * auto-logging (see interaction-logging.js) and adds worker-scoped
 * fixtures that accumulate this worker's interaction log and manifest
 * snapshots, flushed to `.shiny.cov/*-worker-{workerIndex}.json` after
 * every test (and again at worker teardown as a final safety net) -- see
 * global-teardown.js for how those get merged into the single files
 * shiny.cov::collect()/shiny.cov::ui_report() read.
 *
 * Usage in a test file:
 *
 *   const { test, expect } = require('shiny.cov-playwright')
 *
 *   test('fills the form', async ({ page }) => {
 *     await page.goto('/')
 *     await page.locator('#name').fill('Alice')
 *   })
 *
 * @module shiny.cov-playwright/fixtures
 */

'use strict'

const fs = require('fs')
const path = require('path')
const { test: baseTest, expect } = require('@playwright/test')
const { discoverManifest } = require('./discover.js')
const { wrapWithLogging } = require('./interaction-logging.js')

function shinyCovOutputDir(appDir) {
  return path.join(path.resolve(appDir), '.shiny.cov')
}

/**
 * Write one worker's accumulated entries to its own file, replacing
 * whatever was there before. Called after every test (see
 * shinyCovAutoDiscover below) as well as at worker teardown, so it always
 * receives the full in-memory array rather than just what's new since the
 * last call -- a plain overwrite keeps that idempotent no matter how often
 * it runs. A no-op when empty, so a worker that never interacted with the
 * page (or crashed before logging anything) doesn't leave a stray empty
 * file for global-teardown.js to glob.
 * @param {string} appDir
 * @param {string} kind `"interactions"` or `"manifest-snapshots"`.
 * @param {number} workerIndex
 * @param {Array} entries
 */
function flushWorkerFile(appDir, kind, workerIndex, entries) {
  if (!entries || entries.length === 0) return
  const outDir = shinyCovOutputDir(appDir)
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, `${kind}-worker-${workerIndex}.json`)
  // A plain writeFileSync() truncates the file before writing the new
  // content, so a process kill mid-write (not just between tests) leaves
  // a 0-byte or partial file behind -- losing every entry flushed so far
  // this worker, not just whatever was in flight. Writing to a sibling
  // temp file first and renaming over the real path is atomic on the
  // same filesystem: a kill at any point before the rename leaves the
  // previous, still-valid file untouched.
  const tmpPath = `${outPath}.tmp-${process.pid}`
  fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2))
  fs.renameSync(tmpPath, outPath)
}

// Set once a worker has already warned about a shinyCovDiscoverManifest()
// failure, so a systematically-failing discovery path (e.g. a CSP
// restriction, an API drift) prints one diagnosable message per worker
// process instead of one per test. Module-level state is scoped correctly
// for this on its own: each worker is a separate Node process with its own
// fresh module registry, so this resets naturally per worker without any
// explicit per-worker bookkeeping.
let warnedAutoDiscoverFailure = false

const test = baseTest.extend({
  // Resolves where per-worker interaction/manifest files get written. Set
  // via a project's `use` block in playwright.config.ts -- mirrors
  // shiny.cov-cypress's config.env.shinyCovAppDir. Worker-scoped (not the
  // default test scope): the fixtures below that read it are themselves
  // worker-scoped, and Playwright requires an option a worker fixture
  // depends on to be at least as broad in scope as that fixture -- a
  // test-scoped option can vary per test, which a worker fixture (set up
  // once for the whole worker) can't react to.
  shinyCovAppDir: ['.', { option: true, scope: 'worker' }],

  // Worker-scoped: workers are separate OS processes that can't
  // communicate (Playwright's own documented parallel-test model), so each
  // one just accumulates its own entries in memory for its whole lifetime
  // -- no cross-worker coordination at all. global-teardown.js merges every
  // worker's file into one after the whole run finishes, the same
  // per-worker-file-then-merge shape Playwright's own blob reporter uses
  // for test results.
  //
  // The flush below (after `use(entries)` returns, i.e. at worker
  // teardown) is a final safety net, not the primary write path: the
  // shinyCovAutoDiscover fixture flushes the same array after every test,
  // so a worker that's hard-killed before reaching its own teardown (a
  // timeout escalating to SIGKILL, an OOM kill, a native browser crash
  // taking Node down with it) only loses the test that was in flight, not
  // everything the worker logged since the run started.
  shinyCovInteractionLog: [async ({ shinyCovAppDir }, use, workerInfo) => {
    const entries = []
    await use(entries)
    flushWorkerFile(shinyCovAppDir, 'interactions', workerInfo.workerIndex, entries)
  }, { scope: 'worker' }],

  // Worker-scoped, same shape (and same per-test flush via
  // shinyCovAutoDiscover) as shinyCovInteractionLog, but for raw,
  // unmerged manifest snapshots. Deliberately NOT merged here -- R gains
  // the read-time merge for this format (manifest_read_path()/
  // read_manifest_from_path() in shiny.cov-r/R/utils.R), so this fixture and
  // global-teardown.js only ever accumulate/concatenate, never merge.
  shinyCovManifestSnapshots: [async ({ shinyCovAppDir }, use, workerInfo) => {
    const snapshots = []
    await use(snapshots)
    flushWorkerFile(shinyCovAppDir, 'manifest-snapshots', workerInfo.workerIndex, snapshots)
  }, { scope: 'worker' }],

  // Overrides the built-in `page` fixture (the documented test.extend()
  // mechanism for this -- Playwright constructs the real `page` first,
  // this wraps it before the test ever sees it) with a Proxy that observes
  // real Locator/Page method calls and logs the recognized ones. Preserves
  // `this` binding on every call (interaction-logging.js's
  // `value.apply(target, args)`), so Playwright's own auto-wait/retry/
  // tracing internals -- which live inside those real methods, called
  // normally -- are untouched.
  //
  // Parsing Reporter onStepEnd's TestStep.title strings instead of
  // wrapping would be unreliable: TestStep.title does embed selector/value,
  // but is documented only as a "user-friendly" string, not a stable
  // format, and framework/lifecycle steps (e.g. "Launch browser") share
  // the same pw:api step category as real actions -- this observes real
  // call arguments directly instead of regex-parsing a string not meant
  // to be machine-read.
  // `isPageRoot: true` marks this as the actual page object, not merely a
  // Locator that hasn't been assigned a selector yet -- see
  // interaction-logging.js's wrapWithLogging() doc for why that distinction
  // has to be tracked explicitly rather than inferred from `selector` alone.
  page: async ({ page, shinyCovInteractionLog }, use) => {
    await use(wrapWithLogging(page, null, shinyCovInteractionLog, true))
  },

  // Callable fixture: discovers the live UI manifest and records it as one
  // more snapshot for this worker. Exposed explicitly (not just the
  // auto-fixture below) so a test can call it mid-test right after
  // revealing transient UI (a modal, a wizard step) and before it's
  // removed again -- the same reason AppDriver$discover_manifest() is
  // public in shiny.cov-r/R/shinytest2.R.
  shinyCovDiscoverManifest: async ({ page, shinyCovManifestSnapshots }, use) => {
    await use(async () => {
      const manifest = await discoverManifest(page)
      shinyCovManifestSnapshots.push(manifest)
      return manifest
    })
  },

  // Auto-fixture: snapshots the manifest once after every test without
  // requiring a test author to remember to call shinyCovDiscoverManifest()
  // themselves -- mirrors the Cypress adapter's global afterEach(). A
  // discovery failure (e.g. the page already navigated away/closed) doesn't
  // fail the test -- it just means this test doesn't contribute a manifest
  // snapshot -- but is reported via console.warn (rate-limited to once per
  // worker via warnedAutoDiscoverFailure above) rather than swallowed, so a
  // systematically-failing discovery path is diagnosable instead of
  // silently looking like "this app has little UI."
  //
  // Also the primary flush point for both shinyCovInteractionLog and
  // shinyCovManifestSnapshots (see their own comments above): writing the
  // worker's file after every test, not only at worker teardown, is what
  // bounds a hard-killed worker's data loss to the one test in flight.
  shinyCovAutoDiscover: [async ({
    shinyCovDiscoverManifest,
    shinyCovInteractionLog,
    shinyCovManifestSnapshots,
    shinyCovAppDir
  }, use, testInfo) => {
    await use()
    try {
      await shinyCovDiscoverManifest()
    } catch (err) {
      if (!warnedAutoDiscoverFailure) {
        warnedAutoDiscoverFailure = true
        console.warn(
          `shiny.cov: auto-discover failed after a test -- ${err.message} ` +
          '(further failures on this worker will not be logged individually)'
        )
      }
    }
    flushWorkerFile(shinyCovAppDir, 'interactions', testInfo.workerIndex, shinyCovInteractionLog)
    flushWorkerFile(shinyCovAppDir, 'manifest-snapshots', testInfo.workerIndex, shinyCovManifestSnapshots)
  }, { auto: true }]
})

module.exports = { test, expect }

// Exported for this package's own unit tests (test/fixtures.test.js) --
// not part of the public API consumers should rely on (see package.json's
// "exports" map, which only exposes "."/"./fixtures"/"./discover"/
// "./global-teardown").
module.exports.flushWorkerFile = flushWorkerFile
module.exports.shinyCovOutputDir = shinyCovOutputDir
