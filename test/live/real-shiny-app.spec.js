// Verifies the adapter against a real, booted Shiny/R process (this
// directory's own test/live/fixture-app, launched via this config's
// `webServer`), not the hand-authored `window.Shiny` mock the other specs
// in this directory use. Confirms the Proxy-based logging and manifest
// discovery work unmodified against real Shiny.js input/output bindings --
// the bindings the mock only approximates.
'use strict'

const { test, expect } = require('../../src/fixtures.js')

test('logs interactions and discovers the manifest against a real, running Shiny app', async ({
  page,
  shinyCovInteractionLog,
  shinyCovDiscoverManifest
}) => {
  await page.goto('/')
  await page.locator('#go').waitFor()

  await page.locator('#name').fill('Ada')
  await page.locator('#go').click()

  const fillEntry = shinyCovInteractionLog.find((e) => e.selector === '#name' && e.action === 'fill')
  expect(fillEntry).toBeTruthy()
  expect(fillEntry.value).toBe('Ada')

  const clickEntry = shinyCovInteractionLog.find((e) => e.selector === '#go' && e.action === 'click')
  expect(clickEntry).toBeTruthy()

  const manifest = await shinyCovDiscoverManifest()
  expect(manifest.inputs.map((i) => i.id).sort()).toEqual(['bins', 'dataset', 'go', 'name'])
  expect(manifest.outputs.map((o) => o.id).sort()).toEqual(['dataTable', 'distPlot'])
})
