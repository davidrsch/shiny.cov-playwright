// Real-browser verification of mechanisms unit tests can only mock:
// (1) the Proxy-based interaction logging, including a chained
//     .filter().locator().click() call, against real Playwright
//     Locator/Page objects, not stand-ins;
// (2) discover.js's indirect-eval wrapping of the vendored discovery
//     script, run via a real page.evaluate() round trip through an actual
//     browser process, not node:vm;
// (3) getByRole()/getByLabel() locators against a real Locator, whose
//     selector: null (shared with the page root) makes the page-level
//     selector-consuming heuristic a real risk to re-verify live, not just
//     against hand-built mocks; and
// (4) a real FrameLocator, whose narrower method surface (no .click()/
//     .fill()) is what makes it fail looksLikeLocator() in the first place.
'use strict'

const { test, expect } = require('../../src/fixtures.js')

test('logs fill/click including a chained call, and discovers a manifest, against a real browser', async ({
  page,
  shinyCovInteractionLog,
  shinyCovDiscoverManifest
}) => {
  // shinyCovInteractionLog is worker-scoped, not test-scoped, so it
  // accumulates entries across every test that runs in this worker,
  // including other spec files (e.g. real-shiny-app.spec.js) when they
  // land in the same worker -- slice from here rather than searching the
  // whole array, matching the pattern the other tests in this file already
  // use for the same reason.
  const startIndex = shinyCovInteractionLog.length

  // page.setContent() writes into the existing document (document.open/
  // write/close under the hood) rather than performing a real navigation,
  // so page.addInitScript() -- which only fires on navigation -- would
  // never run here; set window.Shiny with a plain evaluate() afterward
  // instead.
  await page.setContent(`
    <input id="my-input">
    <button id="my-button">Go</button>
    <ul>
      <li class="item">Alpha <button class="delete">x</button></li>
      <li class="item">Beta <button class="delete">x</button></li>
    </ul>
  `)

  await page.evaluate(() => {
    window.Shiny = {
      inputBindings: {
        bindingNames: {
          'shiny.textInput': {
            binding: { find: () => [document.getElementById('my-input')], getId: (el) => el.id }
          },
          'shiny.actionButtonInput': {
            binding: { find: () => [document.getElementById('my-button')], getId: (el) => el.id }
          }
        }
      },
      outputBindings: { bindingNames: {} }
    }
  })

  await page.locator('#my-input').fill('hello world')
  await page.locator('#my-button').click()

  // Recursive-Locator-wrapping, against the real thing: .filter() and the
  // second .locator() each return a new real Locator; the final .click()
  // must still be logged.
  await page.locator('.item').filter({ hasText: 'Beta' }).locator('.delete').click()

  const entries = shinyCovInteractionLog.slice(startIndex)

  const fillEntry = entries.find((e) => e.action === 'fill')
  expect(fillEntry).toBeTruthy()
  expect(fillEntry.value).toBe('hello world')
  expect(fillEntry.selector).toBe('#my-input')

  const clickEntries = entries.filter((e) => e.action === 'click')
  expect(clickEntries.length).toBe(2)
  expect(clickEntries.some((e) => e.selector === '#my-button')).toBe(true)
  // The chained call's selector: '.item' (from the first .locator()) is
  // inherited through .filter() (which doesn't itself take a selector
  // string) and then extended by the second .locator('.delete').
  expect(clickEntries.some((e) => e.selector === '.item >> .delete')).toBe(true)

  const manifest = await shinyCovDiscoverManifest()
  expect(manifest.inputs.map((i) => i.id).sort()).toEqual(['my-button', 'my-input'])
})

test('getByRole/getByLabel interactions log a real selector and value, against a real browser', async ({
  page,
  shinyCovInteractionLog
}) => {
  // shinyCovInteractionLog is worker-scoped, not test-scoped, so it
  // accumulates entries across every test in this file -- slice from here
  // rather than searching the whole array, to avoid matching an entry left
  // over from an earlier test.
  const startIndex = shinyCovInteractionLog.length

  await page.setContent(`
    <label for="name-field">Name</label>
    <input id="name-field">
    <button id="go-button">Go</button>
  `)

  await page.getByRole('button', { name: 'Go' }).click()
  await page.getByLabel('Name').fill('Alice')

  const entries = shinyCovInteractionLog.slice(startIndex)

  const clickEntry = entries.find((e) => e.action === 'click')
  expect(clickEntry).toBeTruthy()
  expect(clickEntry.selector).toBeTruthy()
  expect(clickEntry.selector).toContain('button')
  expect(clickEntry.selector).toContain('Go')

  const fillEntry = entries.find((e) => e.action === 'fill')
  expect(fillEntry).toBeTruthy()
  expect(fillEntry.value).toBe('Alice')
  expect(fillEntry.selector).toBeTruthy()
  expect(fillEntry.selector).not.toBe('Alice')
})

test('an interaction inside a frameLocator() chain is logged, against a real browser', async ({
  page,
  shinyCovInteractionLog
}) => {
  const startIndex = shinyCovInteractionLog.length

  await page.setContent(`
    <iframe id="my-iframe" srcdoc="<button id='inner-button'>Inner</button>"></iframe>
  `)

  await page.frameLocator('#my-iframe').locator('#inner-button').click()

  const entries = shinyCovInteractionLog.slice(startIndex)

  const clickEntry = entries.find((e) => e.action === 'click')
  expect(clickEntry).toBeTruthy()
  expect(clickEntry.selector).toBeTruthy()
  expect(clickEntry.selector).toContain('#my-iframe')
  expect(clickEntry.selector).toContain('#inner-button')
})
