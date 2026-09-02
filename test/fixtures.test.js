/**
 * Tests for src/fixtures.js's own logic that doesn't require a real
 * Playwright test run: the exported test/expect shape, and
 * flushWorkerFile()'s file-writing behavior (the same function the
 * worker-scoped shinyCovInteractionLog/shinyCovManifestSnapshots
 * fixtures call from their teardown). The Proxy-wrapping logic itself is
 * covered by test/interaction-logging.test.js; the full fixture wiring
 * (worker scoping, auto-discovery, page override) is exercised end-to-end
 * against a real browser in test/live/ -- test.extend()'s fixture-resolution
 * machinery isn't something a plain node:test run can drive without
 * actually starting Playwright's test runner.
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const shinyCovFixtures = require('../src/fixtures.js')

test('exports test and expect', () => {
  assert.strictEqual(typeof shinyCovFixtures.test, 'function')
  assert.strictEqual(typeof shinyCovFixtures.test.extend, 'function')
  assert.strictEqual(typeof shinyCovFixtures.expect, 'function')
})

test('package.json "." and "./fixtures" both resolve to a module exporting test/expect', () => {
  delete require.cache[require.resolve('shiny.cov-playwright')]
  delete require.cache[require.resolve('shiny.cov-playwright/fixtures')]
  const viaMain = require('shiny.cov-playwright')
  const viaFixtures = require('shiny.cov-playwright/fixtures')
  assert.strictEqual(typeof viaMain.test, 'function')
  assert.strictEqual(typeof viaFixtures.test, 'function')
})

test('flushWorkerFile() writes entries to <appDir>/.shiny.cov/<kind>-worker-<index>.json', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiny.cov-playwright-flush-'))
  const entries = [{ selector: '#a', action: 'click', value: null, timestamp: 1 }]

  shinyCovFixtures.flushWorkerFile(appDir, 'interactions', 3, entries)

  const outPath = path.join(appDir, '.shiny.cov', 'interactions-worker-3.json')
  assert.strictEqual(fs.existsSync(outPath), true)
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(outPath, 'utf8')), entries)
})

test('flushWorkerFile() is a no-op for an empty entries array -- no stray file for a worker that logged nothing', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiny.cov-playwright-flush-empty-'))

  shinyCovFixtures.flushWorkerFile(appDir, 'interactions', 0, [])

  const outPath = path.join(appDir, '.shiny.cov', 'interactions-worker-0.json')
  assert.strictEqual(fs.existsSync(outPath), false)
})

test('flushWorkerFile() leaves no leftover temp file behind on a normal write', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiny.cov-playwright-flush-tmp-'))
  const entries = [{ selector: '#a', action: 'click', value: null, timestamp: 1 }]

  shinyCovFixtures.flushWorkerFile(appDir, 'interactions', 0, entries)

  const outDir = path.join(appDir, '.shiny.cov')
  const files = fs.readdirSync(outDir)
  assert.deepStrictEqual(files, ['interactions-worker-0.json'])
})

test('flushWorkerFile() replaces the previous file atomically -- a failed write cannot leave a torn file', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiny.cov-playwright-flush-atomic-'))
  const outPath = path.join(appDir, '.shiny.cov', 'interactions-worker-0.json')
  const goodEntries = [{ selector: '#a', action: 'click', value: null, timestamp: 1 }]

  shinyCovFixtures.flushWorkerFile(appDir, 'interactions', 0, goodEntries)

  // Simulate the write step failing after the temp file exists but before
  // the rename would happen (the same window a process kill could land
  // in) by making fs.renameSync throw, matching the real function's own
  // sequencing: writeFileSync(tmp) succeeds, then renameSync(tmp, real).
  const originalRename = fs.renameSync
  fs.renameSync = () => { throw new Error('simulated crash before rename') }
  try {
    assert.throws(() => {
      shinyCovFixtures.flushWorkerFile(appDir, 'interactions', 0, [
        { selector: '#b', action: 'click', value: null, timestamp: 2 },
      ])
    })
  } finally {
    fs.renameSync = originalRename
  }

  // The previous, fully-written content survives untouched -- never
  // truncated, never partially overwritten.
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(outPath, 'utf8')), goodEntries)
})

test('shinyCovOutputDir() resolves relative to the given appDir', () => {
  const resolved = shinyCovFixtures.shinyCovOutputDir('some/relative/app')
  assert.ok(path.isAbsolute(resolved))
  assert.ok(resolved.endsWith(path.join('some', 'relative', 'app', '.shiny.cov')))
})

test('flushWorkerFile() overwrites with the full current array on each call -- repeated calls stay idempotent', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiny.cov-playwright-flush-repeat-'))
  const outPath = path.join(appDir, '.shiny.cov', 'interactions-worker-0.json')

  const afterTest1 = [{ selector: '#a', action: 'click', value: null, timestamp: 1 }]
  shinyCovFixtures.flushWorkerFile(appDir, 'interactions', 0, afterTest1)
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(outPath, 'utf8')), afterTest1)

  const afterTest2 = afterTest1.concat([{ selector: '#b', action: 'fill', value: 'x', timestamp: 2 }])
  shinyCovFixtures.flushWorkerFile(appDir, 'interactions', 0, afterTest2)
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(outPath, 'utf8')), afterTest2)
})

test('simulated worker crash: only entries flushed before the crash survive on disk', () => {
  // Models the shape of the real fixture: shinyCovAutoDiscover flushes the
  // worker's full in-memory array after every test. A "crash" here is just
  // never calling flushWorkerFile() again after entries are appended in
  // memory -- exactly what a SIGKILL between two tests would look like, no
  // real process needed to demonstrate the property this design change is
  // for (see the live multi-worker test for the real-process version).
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiny.cov-playwright-flush-crash-'))
  const outPath = path.join(appDir, '.shiny.cov', 'interactions-worker-0.json')
  const inMemory = []

  inMemory.push({ selector: '#test1', action: 'click', value: null, timestamp: 1 })
  shinyCovFixtures.flushWorkerFile(appDir, 'interactions', 0, inMemory) // test 1 ends, flushes

  inMemory.push({ selector: '#test2', action: 'click', value: null, timestamp: 2 }) // test 2 starts logging...
  // ...then the worker is killed before test 2's flush runs. No further
  // flushWorkerFile() call happens for this entry.

  const onDisk = JSON.parse(fs.readFileSync(outPath, 'utf8'))
  assert.deepStrictEqual(onDisk, [{ selector: '#test1', action: 'click', value: null, timestamp: 1 }])
  assert.strictEqual(onDisk.some((e) => e.selector === '#test2'), false)
})
