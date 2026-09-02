/**
 * Tests for src/interaction-logging.js against hand-built mock page/Locator
 * objects (a real Playwright browser isn't a plain Node dependency here --
 * see test/live/ for the same wrapping mechanism re-exercised against a
 * real browser). Covers: basic logging, `this`-binding preservation,
 * ignoring non-logged methods, page-level vs Locator-level selector/value
 * extraction, and -- the case flagged as a real risk, not assumed away --
 * the recursive-Locator-wrapping problem for chained calls.
 */
const test = require('node:test')
const assert = require('node:assert')

const { wrapWithLogging, looksLikeLocator, looksLikeFrameLocator, pickValue, LOGGED_ACTIONS } = require('../src/interaction-logging.js')

/**
 * A minimal Locator stand-in. Real Playwright Locator methods that return
 * a new Locator (`.filter()`, `.first()`, `.nth()`, `.and()`, `.or()`,
 * `.locator()`) are synchronous; action methods (`.click()`, `.fill()`,
 * ...) are async. Mirrors that split so wrapWithLogging()'s `.then`-based
 * sync/async branch is exercised the same way it would be for real.
 */
function makeMockLocator(name, { childLocators = {} } = {}) {
  const calls = []
  const locator = {
    name,
    calls,
    click: async (...args) => { calls.push(['click', args]); return undefined },
    dblclick: async (...args) => { calls.push(['dblclick', args]); return undefined },
    fill: async (...args) => { calls.push(['fill', args]); return undefined },
    check: async (...args) => { calls.push(['check', args]); return undefined },
    textContent: async (...args) => { calls.push(['textContent', args]); return 'some text' },
    waitFor: async (...args) => { calls.push(['waitFor', args]); return undefined }, // not a logged action
    count: async (...args) => { calls.push(['count', args]); return 1 }, // not a logged action
    locator: (selector) => childLocators[selector] || makeMockLocator(`${name} >> ${selector}`),
    filter: (opts) => { calls.push(['filter', [opts]]); return childLocators.filter || makeMockLocator(`${name}.filter()`) },
    first: () => childLocators.first || makeMockLocator(`${name}.first()`)
  }
  return locator
}

function makeMockPage({ locators = {} } = {}) {
  const calls = []
  return {
    calls,
    // Page-level convenience methods take the selector as their own first
    // argument (page.click(selector), unlike locator.click()).
    click: async (selector, ...rest) => { calls.push(['click', [selector, ...rest]]); return undefined },
    fill: async (selector, value, ...rest) => { calls.push(['fill', [selector, value, ...rest]]); return undefined },
    goto: async (url) => { calls.push(['goto', [url]]); return undefined }, // not a logged action
    locator: (selector) => locators[selector] || makeMockLocator(selector),
    getByRole: (role, options) => makeMockLocator(`role:${role}`),
    getByLabel: (text, options) => makeMockLocator(`label:${text}`),
    getByText: (text, options) => makeMockLocator(`text:${text}`),
    getByTestId: (id) => makeMockLocator(`testid:${id}`),
    frameLocator: (selector) => makeMockFrameLocator(`frame:${selector}`)
  }
}

/**
 * A minimal FrameLocator stand-in, matching a real Playwright FrameLocator's
 * narrower surface: `.locator()`/`.frameLocator()`, no `.click()`/`.fill()`
 * -- this is exactly the shape `looksLikeFrameLocator()` duck-types.
 */
function makeMockFrameLocator(name) {
  return {
    name,
    locator: (selector) => makeMockLocator(`${name} >> ${selector}`),
    frameLocator: (selector) => makeMockFrameLocator(`${name} >> frame(${selector})`)
  }
}

test('looksLikeLocator() duck-types click/fill/locator', () => {
  // Real Playwright's Page also exposes click()/fill()/locator() (its own
  // deprecated-but-valid convenience methods), so it duck-types as
  // "Locator-like" by this same check -- harmless in practice, since no
  // Playwright method's *return value* is ever the Page object itself, only
  // Locator-returning methods produce something this check needs to catch.
  assert.strictEqual(looksLikeLocator(makeMockLocator('x')), true)
  assert.strictEqual(looksLikeLocator(null), false)
  assert.strictEqual(looksLikeLocator('a string'), false)
  assert.strictEqual(looksLikeLocator(42), false)
  assert.strictEqual(looksLikeLocator({ click: 'not a function' }), false)
})

test('pickValue() returns null for no-value actions regardless of arguments', () => {
  assert.strictEqual(pickValue('click', [{ force: true }], false), null)
  assert.strictEqual(pickValue('check', [], false), null)
})

test('pickValue() returns the first argument for value-bearing actions', () => {
  assert.strictEqual(pickValue('fill', ['hello'], false), 'hello')
  assert.strictEqual(pickValue('press', ['Enter'], false), 'Enter')
})

test('pickValue() skips the selector argument for page-level (selector-consuming) calls', () => {
  assert.strictEqual(pickValue('fill', ['#name', 'Alice'], true), 'Alice')
})

test('pickValue() JSON-round-trips a structured value and drops non-serializable ones', () => {
  assert.deepStrictEqual(pickValue('selectOption', [{ label: 'Option A' }], false), { label: 'Option A' })
  const circular = {}
  circular.self = circular
  assert.strictEqual(pickValue('setInputFiles', [circular], false), null)
})

test('wrapWithLogging: logs a Locator-bound action with the tracked selector', async () => {
  const log = []
  const real = makeMockLocator('#bins')
  const wrapped = wrapWithLogging(real, '#bins', log)

  await wrapped.fill('20')

  assert.strictEqual(log.length, 1)
  assert.deepStrictEqual(log[0].selector, '#bins')
  assert.strictEqual(log[0].action, 'fill')
  assert.strictEqual(log[0].value, '20')
  assert.strictEqual(typeof log[0].timestamp, 'number')
})

test('wrapWithLogging: preserves `this` binding -- the real method still sees its own object', async () => {
  const real = makeMockLocator('#go')
  const wrapped = wrapWithLogging(real, '#go', [])

  await wrapped.click()

  // real.calls is the same array closed over by the real click() method;
  // if `this` binding were lost, click() would throw or push into some
  // other object's `calls` instead.
  assert.deepStrictEqual(real.calls, [['click', []]])
})

test('wrapWithLogging: does not log methods outside the action vocabulary', async () => {
  const log = []
  const real = makeMockLocator('#list')
  const wrapped = wrapWithLogging(real, '#list', log)

  await wrapped.waitFor()
  await wrapped.count()

  assert.strictEqual(log.length, 0)
  assert.ok(!LOGGED_ACTIONS.has('waitFor'))
  assert.ok(!LOGGED_ACTIONS.has('count'))
})

test('wrapWithLogging: page-level call uses its own first argument as the selector', async () => {
  const log = []
  const page = makeMockPage()
  const wrapped = wrapWithLogging(page, null, log, true)

  await wrapped.click('#submit')

  assert.strictEqual(log.length, 1)
  assert.strictEqual(log[0].selector, '#submit')
  assert.strictEqual(log[0].action, 'click')
})

test('wrapWithLogging: page.locator(selector) returns a wrapped Locator carrying that selector', async () => {
  const log = []
  const page = makeMockPage()
  const wrapped = wrapWithLogging(page, null, log, true)

  const child = wrapped.locator('#name')
  await child.fill('Alice')

  assert.strictEqual(log.length, 1)
  assert.strictEqual(log[0].selector, '#name')
  assert.strictEqual(log[0].value, 'Alice')
})

// ---- The recursive-Locator-wrapping problem ----
//
// .filter()/.first()/.nth()/.and()/.or()/.locator() all return a NEW real
// Locator. A shallow Proxy only intercepts calls on the exact object it
// wraps, so without detecting and re-wrapping a Locator-shaped return
// value, a chained call like page.locator('#list').filter({...}).click()
// would silently stop being logged after .filter() -- this is exactly the
// case flagged as needing to be built and tested, not assumed to work.

test('wrapWithLogging: a chained .filter().click() call is still logged (recursive re-wrap)', async () => {
  const log = []
  const filtered = makeMockLocator('#list.filter()')
  const page = makeMockPage({
    locators: { '#list': makeMockLocator('#list', { childLocators: { filter: filtered } }) }
  })
  const wrapped = wrapWithLogging(page, null, log, true)

  await wrapped.locator('#list').filter({ hasText: 'Delete' }).click()

  const clickEntry = log.find((e) => e.action === 'click')
  assert.ok(clickEntry, 'the click() at the end of the chain must still be logged')
  // filter() itself isn't a logged action, but the selector context from
  // .locator('#list') must have propagated through it to the final click.
  assert.strictEqual(clickEntry.selector, '#list')
})

test('wrapWithLogging: a chain of .first().click() is also logged (single-hop sanity check)', async () => {
  const log = []
  const first = makeMockLocator('#items.first()')
  const page = makeMockPage({
    locators: { '.item': makeMockLocator('.item', { childLocators: { first } }) }
  })
  const wrapped = wrapWithLogging(page, null, log, true)

  await wrapped.locator('.item').first().click()

  const clickEntry = log.find((e) => e.action === 'click')
  assert.ok(clickEntry)
  assert.strictEqual(clickEntry.selector, '.item')
})

test('wrapWithLogging: a three-hop chain (.locator().filter().locator()) still logs the final action', async () => {
  const log = []
  const innermost = makeMockLocator('button')
  const filtered = makeMockLocator('row.filter()', { childLocators: { button: innermost } })
  filtered.locator = (selector) => (selector === 'button' ? innermost : makeMockLocator('unexpected'))
  const rowLocator = makeMockLocator('.row', { childLocators: { filter: filtered } })
  const page = makeMockPage({ locators: { '.row': rowLocator } })
  const wrapped = wrapWithLogging(page, null, log, true)

  await wrapped.locator('.row').filter({ hasText: 'Delete' }).locator('button').click()

  const clickEntry = log.find((e) => e.action === 'click')
  assert.ok(clickEntry, 'the click() at the end of a 3-hop chain must still be logged')
})

// ---- getBy*() locators ----
//
// page.getByRole()/getByLabel()/getByText()/etc. are Playwright's own
// recommended, idiomatic locator API. Because the Locator they return is
// rooted at `page` (selector: null) just like any other Locator-returning
// call, it needs its own synthesized selector rather than inheriting
// `page`'s -- otherwise it would be indistinguishable from the page root
// itself and get its selector/value corrupted by the page-level
// selector-consuming heuristic.

test('wrapWithLogging: getByRole().click() logs a non-null selector describing the role and name', async () => {
  const log = []
  const page = makeMockPage()
  const wrapped = wrapWithLogging(page, null, log, true)

  await wrapped.getByRole('button', { name: 'Go' }).click()

  assert.strictEqual(log.length, 1)
  assert.strictEqual(log[0].action, 'click')
  assert.ok(log[0].selector, 'selector must not be null/empty')
  assert.match(log[0].selector, /button/)
  assert.match(log[0].selector, /Go/)
})

test('wrapWithLogging: getByLabel().fill() logs the real value and a non-null selector', async () => {
  const log = []
  const page = makeMockPage()
  const wrapped = wrapWithLogging(page, null, log, true)

  await wrapped.getByLabel('Name').fill('Alice')

  assert.strictEqual(log.length, 1)
  assert.strictEqual(log[0].action, 'fill')
  assert.strictEqual(log[0].value, 'Alice')
  assert.ok(log[0].selector, 'selector must not be null/empty')
  assert.notStrictEqual(log[0].selector, 'Alice')
})

test('wrapWithLogging: getByTestId().click() logs a non-null selector referencing the test id', async () => {
  const log = []
  const page = makeMockPage()
  const wrapped = wrapWithLogging(page, null, log, true)

  await wrapped.getByTestId('submit-button').click()

  assert.strictEqual(log.length, 1)
  assert.strictEqual(log[0].action, 'click')
  assert.ok(log[0].selector, 'selector must not be null/empty')
  assert.match(log[0].selector, /submit-button/)
})

// ---- FrameLocator ----
//
// page.frameLocator() returns a real FrameLocator, whose surface
// (.locator()/.frameLocator(), no .click()/.fill()) fails looksLikeLocator()
// -- it needs its own duck-type check so it gets wrapped instead of handed
// back raw, which would otherwise leave every interaction inside that
// iframe unlogged.

test('looksLikeFrameLocator() duck-types locator/frameLocator without click', () => {
  assert.strictEqual(looksLikeFrameLocator(makeMockFrameLocator('frame')), true)
  assert.strictEqual(looksLikeFrameLocator(makeMockLocator('x')), false)
  assert.strictEqual(looksLikeFrameLocator(null), false)
  assert.strictEqual(looksLikeFrameLocator({ locator: () => {}, frameLocator: () => {}, click: () => {} }), false)
})

test('wrapWithLogging: an interaction inside a wrapped frameLocator() chain is logged', async () => {
  const log = []
  const page = makeMockPage()
  const wrapped = wrapWithLogging(page, null, log, true)

  await wrapped.frameLocator('#some-iframe').locator('#btn').click()

  const clickEntry = log.find((e) => e.action === 'click')
  assert.ok(clickEntry, 'the click() inside the iframe must be logged')
  assert.ok(clickEntry.selector, 'selector must not be null/empty')
  assert.match(clickEntry.selector, /#some-iframe/)
  assert.match(clickEntry.selector, /#btn/)
})
