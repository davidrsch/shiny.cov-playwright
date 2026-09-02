# shiny.cov-playwright

Playwright adapter for [the shiny.cov R package](https://github.com/davidrsch/shiny.cov-r) -- UI and server coverage for R Shiny apps. (There's a separate, identically-named `shiny.cov` package for Python/py-shiny with its own native Playwright support -- this adapter only works with R Shiny apps and has no relationship to that package.)

## Installation

```bash
npm install --save-dev shiny.cov-playwright @playwright/test
```

If you're developing this package itself from a local checkout, install it as a real `file:`-protocol dependency rather than reaching into it via a raw relative path outside `node_modules`:

```json
{
  "devDependencies": {
    "shiny.cov-playwright": "file:../path/to/shiny.cov-playwright"
  }
}
```

## Quick start

### 1. Configure Playwright

There is no `server.js`/`plugin.js` equivalent to register -- Playwright's own `webServer` config already implements process spawn, readiness polling, and graceful-then-forceful shutdown, so starting the instrumented app is pure config, not code. `run_covr_server()` is a small internal shiny.cov helper that reads the `SHINYCOV_SERVER_*` env vars below and calls `shiny::runApp()`; it's what the `command` actually invokes.

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test'

const port = 3333
const appDir = 'app'

export default defineConfig({
  globalTeardown: require.resolve('shiny.cov-playwright/global-teardown'),
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // Resolves where the fixtures below read/write .shiny.cov/*.json --
    // must match the app_dir shiny.cov::setup()/shiny.cov::collect() use.
    shinyCovAppDir: appDir
  },
  webServer: {
    command: 'Rscript -e "shiny.cov:::run_covr_server()"', // static, no interpolation
    url: `http://127.0.0.1:${port}`,
    env: {
      SHINYCOV_SERVER_APP_DIR: appDir,
      SHINYCOV_SERVER_PORT: String(port),
      SHINYCOV_OUTPUT: `${appDir}/.shiny.cov/coverage.rds`,
      R_COVR: '1'
    },
    // A newer webServer feature (added in @playwright/test 1.50.0) --
    // reproduces the same 5s-SIGTERM-then-SIGKILL shutdown
    // shiny.cov-cypress's hand-rolled server.js implements manually.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    reuseExistingServer: !process.env.CI
  }
})
```

127.0.0.1, not `localhost`: `shiny::runApp()` binds the IPv4 loopback only, and some Node versions resolve `localhost` to the IPv6 loopback first -- matching `url`/`baseURL` to the same address `run_covr_server()` binds avoids a readiness-poll timeout against a server that's genuinely up.

### 2. Use shiny.cov's `test`/`expect`

```js
// tests/example.spec.js
const { test, expect } = require('shiny.cov-playwright')

test('fills the form', async ({ page }) => {
  await page.goto('/')
  await page.locator('#name').fill('Alice')
  await page.locator('#submit').click()
})
```

Every recognized Locator/Page method call is logged automatically -- no manual `cy.shinyCovInteract()`-style call needed, unlike the Cypress adapter (Playwright's API has no command queue for an automatic wrapper to fight, so wrapping was safe to build here).

### 3. Run tests with coverage

`shiny.cov::setup(app_dir)` must run *before* Playwright's `webServer` starts the app -- it's what writes the `app.R` wrapper that makes `SHINYCOV_OUTPUT` do anything at all. Skipping this step doesn't error; the app just runs uninstrumented and coverage comes back empty. (`R_COVR` is kept only for compatibility with older shiny.cov releases; the current instrumentation reads `SHINYCOV_OUTPUT` and ignores it.)

```r
# setup-coverage.R
shiny.cov::setup("app")
```

```json
// package.json scripts
{
  "setup-coverage": "Rscript setup-coverage.R",
  "test-e2e-coverage": "npm run setup-coverage && playwright test",
  "posttest-e2e-coverage": "Rscript collect-coverage.R"
}
```

```r
# collect-coverage.R
cov <- shiny.cov::collect("app")
covr::report(cov)
shiny.cov::cleanup("app")
```

If a run fails partway through, `app.R` is left wrapped and the next `setup()` call refuses to run until you clean it up -- add a `pretest-e2e-coverage` npm hook that runs `Rscript -e "shiny.cov::cleanup('app')"` so every run starts from a clean slate.

### 4. Recognized actions

Coverage merging only counts interactions whose `action` is in shiny.cov's shared vocabulary (`shiny.cov::shinycov_input_actions()`/`shiny.cov::shinycov_output_actions()`, kept in sync with what this package actually emits):

- Inputs: `click`, `dblclick`, `tap`, `check`, `uncheck`, `fill`, `type`, `press`, `pressSequentially`, `selectOption`, `setInputFiles`, `dragTo`, `clear`, `selectText`, `focus`, `hover`
- Outputs: `textContent`, `innerText`, `innerHTML`, `getAttribute`, `inputValue`

Any other Locator/Page method call (`.waitFor()`, `.count()`, `.boundingBox()`, ...) is not logged -- it isn't a UI interaction the coverage report needs to know about.

## Features

- **Auto-logging via a Proxy-wrapped `page` fixture.** `test.extend()` overrides the built-in `page` fixture (the documented mechanism for this) with a `Proxy` that observes real Locator/Page method calls and logs the recognized ones, preserving `this` binding on every call so Playwright's own auto-wait/retry/tracing -- which live inside the real methods, called normally -- are untouched. Handles the recursive-Locator-wrapping problem: `.filter()`/`.first()`/`.nth()`/`.locator()` each return a *new* Locator, so a chained call like `page.locator('#list').filter({...}).click()` is re-wrapped at every hop, not just the first.

  An alternative was considered and rejected: parsing Playwright Reporter `onStepEnd` `TestStep.title` strings instead of wrapping. Playwright's `TestStep.title` does embed selector/value, but is documented only as a "user-friendly" string, not a stable format, and framework/lifecycle steps share the same `pw:api` step category as real actions. Observing real call arguments directly avoids parsing a string that was never meant to be machine-read.

- **Multi-worker-safe logging.** Workers are separate OS processes that can't communicate (Playwright's own documented model) -- each worker accumulates its own entries in memory and flushes them to `.shiny.cov/interactions-worker-{workerIndex}.json` after every test (plus once more at worker teardown as a final safety net), no cross-worker coordination. Flushing per-test rather than only at worker teardown bounds a hard-killed worker's (timeout, OOM, a native browser crash) data loss to the one test that was in flight. `globalTeardown` (this package's `./global-teardown` export) merges every worker's file into one `interactions.json` after the whole run finishes, then deletes the per-worker files -- the same per-worker-file-then-merge shape Playwright's own blob reporter uses for test results. It also warns if the number of workers that reported any data looks low relative to the run's configured worker count, a heuristic signal for a worker that may have crashed before flushing anything.

- **UI manifest discovery** via `shinyCovDiscoverManifest()`, called automatically after every test (an auto-fixture) and available to call explicitly mid-test for transient UI (a modal, a wizard step) that mounts and unmounts within a single test. Runs the literal same script the R/shinytest2 and Cypress adapters do (`shiny.cov-r/inst/js/discover-bindings.js`, vendored via `scripts/sync-discover-bindings.js`), via `page.evaluate()`. Manifest snapshots are written as a plain array to `manifest-snapshots.json` -- deliberately *not* merged on the JS side; `shiny.cov`'s R side merges the array at read time (`merge_manifest_snapshots()` reduced over the array), so this adapter's write path stays a dumb accumulate rather than a third hand-copy of that merge algorithm. A discovery failure after any given test (an API drift, a CSP restriction, a bug in the vendored script) doesn't fail the test -- it just means that test contributes no manifest snapshot -- but is reported via `console.warn` (once per worker) so a systematically-failing discovery path is diagnosable.

- **No `server.js` equivalent.** Playwright's `webServer` config already implements spawn, readiness polling, and graceful-then-forceful shutdown natively -- see the config block above.

- Peer dependency floor is `@playwright/test >= 1.50.0`, the version that introduced `webServer.gracefulShutdown` (confirmed by diffing `types/test.d.ts` across published versions; if you're pinning tighter for another reason, this is the actual functional floor this package's documented config block relies on).

## License

MIT © David Díaz
