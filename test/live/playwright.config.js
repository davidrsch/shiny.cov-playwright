// Config for the real-browser verification tests in this directory.
// Deliberately separate from the package's `node --test` unit tests
// (test/*.test.js) -- this needs the actual Playwright test runner and a
// real Chromium, not a plain Node process. Not part of `npm test`; run
// explicitly via `npx playwright test -c test/live` from
// shiny.cov-playwright/.
//
// `workers: 1` because every test collected by this config only needs one
// worker between them (none are designed to run in parallel with each
// other) -- multi-worker.spec.js exercises real multi-worker parallelism by
// shelling out to its own nested Playwright run (multi-worker/, excluded
// from this config via testIgnore below) instead, so this run itself
// doesn't need more than one worker.
'use strict'

const fs = require('fs')
const path = require('path')
const { defineConfig } = require('@playwright/test')

const appDir = path.join(__dirname, '.tmp-app')
fs.rmSync(path.join(appDir, '.shiny.cov'), { recursive: true, force: true })

// A small, self-contained demo app (plain shiny::runApp(), no dependency
// on the shiny.cov R package itself) doubles as a real Shiny process here
// -- this adapter's manifest discovery reads window.Shiny directly via
// page.evaluate(), so it has no R-side coupling to exercise beyond a
// running Shiny app.
const realAppDir = path.join(__dirname, 'fixture-app')
const realAppPort = 47821

module.exports = defineConfig({
  testDir: __dirname,
  testIgnore: ['**/multi-worker/**'],
  workers: 1,
  reporter: [['list']],
  globalTeardown: require.resolve('../../src/global-teardown.js'),
  webServer: {
    command: `Rscript -e "shiny::runApp('${realAppDir}', port=${realAppPort}, launch.browser=FALSE, host='127.0.0.1')"`,
    url: `http://127.0.0.1:${realAppPort}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60000
  },
  use: {
    headless: true,
    baseURL: `http://127.0.0.1:${realAppPort}`,
    shinyCovAppDir: appDir
  }
})
