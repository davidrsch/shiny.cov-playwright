// One half of the real multi-worker scenario (see worker-b.spec.js and the
// parent config's comment) -- a single file with two tests, so Playwright's
// scheduler assigns this whole file its own worker process, distinct from
// worker-b.spec.js's. Two tests (not one) so the second test can verify the
// first test's data already reached disk before the second test started --
// a property that depends on the per-test flush wired into
// shinyCovAutoDiscover (fixtures.js), not just the worker-teardown flush.
'use strict'

const fs = require('fs')
const path = require('path')
const { test, expect } = require('../../../src/fixtures.js')

const appDir = path.join(__dirname, '.tmp-app')

test('worker A, test 1: logs a marker', async ({ page, shinyCovInteractionLog }) => {
  await page.setContent('<button id="marker-a1">A1</button>')
  await page.locator('#marker-a1').click()

  expect(shinyCovInteractionLog.some((e) => e.selector === '#marker-a1')).toBe(true)
})

test('worker A, test 2: confirms test 1 already reached this worker\'s file on disk before this test started', async ({
  page,
  shinyCovInteractionLog
}, testInfo) => {
  const workerFile = path.join(appDir, '.shiny.cov', `interactions-worker-${testInfo.workerIndex}.json`)
  const onDiskBeforeThisTest = JSON.parse(fs.readFileSync(workerFile, 'utf8'))
  expect(onDiskBeforeThisTest.some((e) => e.selector === '#marker-a1')).toBe(true)

  await page.setContent('<button id="marker-a2">A2</button>')
  await page.locator('#marker-a2').click()

  expect(shinyCovInteractionLog.some((e) => e.selector === '#marker-a2')).toBe(true)

  // Records this worker's real OS process identity so the parent
  // meta-test (multi-worker.spec.js) can confirm worker A and worker B
  // actually ran as two distinct processes, not just two spec files that
  // happened to share one worker. Written alongside the real output files
  // under .shiny.cov/ (already gitignored) rather than directly in
  // .tmp-app/, so this test-only artifact doesn't need its own ignore rule.
  fs.mkdirSync(path.join(appDir, '.shiny.cov'), { recursive: true })
  fs.writeFileSync(
    path.join(appDir, '.shiny.cov', 'worker-a.identity.json'),
    JSON.stringify({ pid: process.pid, workerIndex: testInfo.workerIndex })
  )
})
