/**
 * Tests for src/discover.js. Two concerns:
 *
 * 1. Does wrapping the vendored source as `new Function('return ' + source)`
 *    actually produce a function that RETURNS the manifest, not just runs
 *    it and discards the result? Cypress's win.eval() returns the value of
 *    the last statement it runs (indirect-eval semantics); a plain
 *    `new Function(source)` with that same script-body text does NOT --
 *    calling it just executes the IIFE and returns undefined, since a
 *    function body only returns what it explicitly `return`s. This is
 *    exercised here via node:vm (Playwright itself isn't a plain Node
 *    dependency), roughly reproducing how Playwright's page.evaluate()
 *    actually runs a function value: stringify it, then invoke the string
 *    in the target context -- see test/live/ for the same claim re-checked
 *    against a real browser.
 * 2. Does discoverManifest() actually call page.evaluate() with something
 *    that, once run, returns the right manifest shape?
 */
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')

const { discoverManifest } = require('../src/discover.js')

function makeMockWindow({ inputBindings = {}, outputBindings = {} } = {}) {
  function makeRegistry(bindingsMap) {
    const bindingNames = {}
    for (const name of Object.keys(bindingsMap)) {
      const elements = bindingsMap[name]
      bindingNames[name] = { binding: { find: () => elements, getId: (el) => el.id } }
    }
    return { bindingNames }
  }

  const win = {
    CSS: { escape: (s) => s },
    Shiny: {
      inputBindings: makeRegistry(inputBindings),
      outputBindings: makeRegistry(outputBindings)
    },
    document: {
      querySelector: () => null,
      querySelectorAll: () => []
    }
  }
  return win
}

/**
 * A mock Playwright `page` whose `.evaluate(fn)` approximates the real
 * mechanism closely enough to catch the return-value bug this file exists
 * to catch: stringify the function value, then invoke that string inside a
 * vm context exposing window/document/CSS, exactly like a real browser
 * evaluating a serialized function against its own global scope would.
 */
function makeMockPage(win) {
  const evalContext = vm.createContext({ window: win, document: win.document, CSS: win.CSS })
  return {
    evaluate: async (fn) => {
      const src = typeof fn === 'function' ? fn.toString() : fn
      return vm.runInContext(`(${src})()`, evalContext)
    }
  }
}

// vm.createContext() gives the evaluated script its own V8 realm, so plain
// objects it constructs carry that realm's Object.prototype rather than
// this test file's -- deepStrictEqual treats that as a mismatch even when
// every property matches. A JSON round-trip produces an equivalent value
// with this realm's prototypes, which is also what actually happens on the
// real path: Playwright's page.evaluate() serializes the result to cross
// the browser/Node boundary.
function toPlainObject(value) {
  return JSON.parse(JSON.stringify(value))
}

test('discoverManifest() returns the manifest, not undefined', async () => {
  const win = makeMockWindow({
    inputBindings: { 'shiny.actionButtonInput': [{ id: 'go' }] }
  })
  const page = makeMockPage(win)

  const manifest = toPlainObject(await discoverManifest(page))

  assert.ok(manifest, 'discoverManifest() must not return undefined/null')
  assert.deepStrictEqual(manifest.inputs, [{ id: 'go', type: 'shiny.actionButtonInput', label: '' }])
  assert.deepStrictEqual(manifest.outputs, [])
})

test('discoverManifest() reflects outputs too', async () => {
  const win = makeMockWindow({
    outputBindings: { 'shiny.textOutput': [{ id: 'result' }] }
  })
  const page = makeMockPage(win)

  const manifest = toPlainObject(await discoverManifest(page))

  assert.deepStrictEqual(manifest.outputs, [{ id: 'result', type: 'shiny.textOutput' }])
})
