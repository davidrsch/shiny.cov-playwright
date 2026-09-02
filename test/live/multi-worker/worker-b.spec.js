// The other half of the real multi-worker scenario -- see worker-a.spec.js
// for what this pairs with and why it's a separate file with two tests.
'use strict'

const fs = require('fs')
const path = require('path')
const { test, expect } = require('../../../src/fixtures.js')

const appDir = path.join(__dirname, '.tmp-app')

test('worker B, test 1: logs a marker', async ({ page, shinyCovInteractionLog }) => {
  await page.setContent('<button id="marker-b1">B1</button>')
  await page.locator('#marker-b1').click()

  expect(shinyCovInteractionLog.some((e) => e.selector === '#marker-b1')).toBe(true)
})

test('worker B, test 2: confirms test 1 already reached this worker\'s file on disk before this test started', async ({
  page,
  shinyCovInteractionLog
}, testInfo) => {
  const workerFile = path.join(appDir, '.shiny.cov', `interactions-worker-${testInfo.workerIndex}.json`)
  const onDiskBeforeThisTest = JSON.parse(fs.readFileSync(workerFile, 'utf8'))
  expect(onDiskBeforeThisTest.some((e) => e.selector === '#marker-b1')).toBe(true)

  await page.setContent('<button id="marker-b2">B2</button>')
  await page.locator('#marker-b2').click()

  expect(shinyCovInteractionLog.some((e) => e.selector === '#marker-b2')).toBe(true)

  // See worker-a.spec.js's matching comment -- written under .shiny.cov/
  // (already gitignored) rather than directly in .tmp-app/.
  fs.mkdirSync(path.join(appDir, '.shiny.cov'), { recursive: true })
  fs.writeFileSync(
    path.join(appDir, '.shiny.cov', 'worker-b.identity.json'),
    JSON.stringify({ pid: process.pid, workerIndex: testInfo.workerIndex })
  )
})
