// Config for a nested Playwright run that exercises real multi-worker
// parallelism -- two separate spec files with no interdependency, run
// under `workers: 2`, so Playwright schedules each onto its own OS
// process. Invoked as a subprocess from ../multi-worker.spec.js rather
// than being scanned directly by ../playwright.config.js (which excludes
// this directory via `testIgnore`), since that parent run's own assertions
// need to happen *after* this nested run's `globalTeardown` has merged
// both workers' files -- not achievable from inside a test in the same run
// whose teardown hasn't happened yet.
'use strict'

const fs = require('fs')
const path = require('path')
const { defineConfig } = require('@playwright/test')

const appDir = path.join(__dirname, '.tmp-app')
fs.rmSync(appDir, { recursive: true, force: true })

module.exports = defineConfig({
  testDir: __dirname,
  workers: 2,
  reporter: [['list']],
  globalTeardown: require.resolve('../../../src/global-teardown.js'),
  use: {
    headless: true,
    shinyCovAppDir: appDir
  }
})
