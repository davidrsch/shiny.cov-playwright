/**
 * Tests for src/global-teardown.js's merge logic against real fixture files
 * on disk (not mocks -- fs operations are cheap and this is the actual
 * contract downstream: real files in, real files out).
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const globalTeardown = require('../src/global-teardown.js')
const { mergeWorkerFiles, resolveOutputDirs, warnIfWorkerCountLooksLow } = globalTeardown

function makeTempOutDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shiny.cov-playwright-teardown-'))
}

test.afterEach(() => {
  delete process.env.SHINYCOV_APP_DIR
})

test('mergeWorkerFiles concatenates every worker file into one array and deletes the originals', () => {
  const outDir = makeTempOutDir()
  fs.writeFileSync(
    path.join(outDir, 'interactions-worker-1.json'),
    JSON.stringify([{ selector: '#a', action: 'click', value: null, timestamp: 1 }])
  )
  fs.writeFileSync(
    path.join(outDir, 'interactions-worker-2.json'),
    JSON.stringify([{ selector: '#b', action: 'fill', value: 'x', timestamp: 2 }])
  )

  const workerIndices = mergeWorkerFiles(outDir, 'interactions', 'interactions.json')

  const merged = JSON.parse(fs.readFileSync(path.join(outDir, 'interactions.json'), 'utf8'))
  assert.strictEqual(merged.length, 2)
  assert.deepStrictEqual(new Set(merged.map((e) => e.selector)), new Set(['#a', '#b']))
  assert.strictEqual(fs.existsSync(path.join(outDir, 'interactions-worker-1.json')), false)
  assert.strictEqual(fs.existsSync(path.join(outDir, 'interactions-worker-2.json')), false)
  assert.deepStrictEqual(workerIndices.sort(), [1, 2])
})

test('mergeWorkerFiles produces the same merged result regardless of which worker file wins the race to be listed first', () => {
  // Playwright's own worker completion order is nondeterministic --
  // fs.readdirSync()'s listing order isn't guaranteed to match creation
  // order either, so this simulates that directly rather than relying on
  // incidental filesystem ordering.
  const outDirA = makeTempOutDir()
  fs.writeFileSync(path.join(outDirA, 'manifest-snapshots-worker-1.json'), JSON.stringify([{ id: 1 }]))
  fs.writeFileSync(path.join(outDirA, 'manifest-snapshots-worker-2.json'), JSON.stringify([{ id: 2 }]))

  const outDirB = makeTempOutDir()
  fs.writeFileSync(path.join(outDirB, 'manifest-snapshots-worker-2.json'), JSON.stringify([{ id: 2 }]))
  fs.writeFileSync(path.join(outDirB, 'manifest-snapshots-worker-1.json'), JSON.stringify([{ id: 1 }]))

  mergeWorkerFiles(outDirA, 'manifest-snapshots', 'manifest-snapshots.json')
  mergeWorkerFiles(outDirB, 'manifest-snapshots', 'manifest-snapshots.json')

  const mergedA = JSON.parse(fs.readFileSync(path.join(outDirA, 'manifest-snapshots.json'), 'utf8'))
  const mergedB = JSON.parse(fs.readFileSync(path.join(outDirB, 'manifest-snapshots.json'), 'utf8'))
  assert.deepStrictEqual(
    mergedA.map((s) => s.id).sort(),
    mergedB.map((s) => s.id).sort()
  )
})

test('mergeWorkerFiles is a no-op when the output directory does not exist', () => {
  const outDir = path.join(os.tmpdir(), 'shiny.cov-playwright-does-not-exist-' + Date.now())
  assert.doesNotThrow(() => mergeWorkerFiles(outDir, 'interactions', 'interactions.json'))
})

test('mergeWorkerFiles is a no-op when no worker files are present', () => {
  const outDir = makeTempOutDir()
  mergeWorkerFiles(outDir, 'interactions', 'interactions.json')
  assert.strictEqual(fs.existsSync(path.join(outDir, 'interactions.json')), false)
})

test('mergeWorkerFiles skips an unparsable worker file rather than aborting the whole merge', () => {
  const outDir = makeTempOutDir()
  fs.writeFileSync(path.join(outDir, 'interactions-worker-1.json'), 'not valid json{{{')
  fs.writeFileSync(
    path.join(outDir, 'interactions-worker-2.json'),
    JSON.stringify([{ selector: '#b', action: 'click', value: null, timestamp: 2 }])
  )

  const workerIndices = mergeWorkerFiles(outDir, 'interactions', 'interactions.json')

  const merged = JSON.parse(fs.readFileSync(path.join(outDir, 'interactions.json'), 'utf8'))
  assert.strictEqual(merged.length, 1)
  assert.strictEqual(merged[0].selector, '#b')

  // A corrupt file (e.g. a worker killed mid-write, leaving a truncated
  // file behind) must not count as "this worker reported data" -- worker
  // 1's index must be absent so warnIfWorkerCountLooksLow() still has a
  // chance to flag the missing data instead of seeing a false "reported".
  assert.deepStrictEqual(workerIndices.sort(), [2])
})

test('warnIfWorkerCountLooksLow fires when a corrupt worker file is present, unlike a plain missing one', () => {
  const outDir = makeTempOutDir()
  fs.writeFileSync(path.join(outDir, 'interactions-worker-1.json'), 'not valid json{{{')
  fs.writeFileSync(
    path.join(outDir, 'interactions-worker-2.json'),
    JSON.stringify([{ selector: '#b', action: 'click', value: null, timestamp: 2 }])
  )

  const workerIndices = mergeWorkerFiles(outDir, 'interactions', 'interactions.json')

  const warnings = []
  const originalWarn = console.warn
  console.warn = (msg) => warnings.push(msg)
  try {
    warnIfWorkerCountLooksLow(outDir, 2, workerIndices, [])
  } finally {
    console.warn = originalWarn
  }

  assert.strictEqual(warnings.length, 1)
  assert.match(warnings[0], /only 1 of up to 2 configured worker/)
})

test('globalTeardown() merges both interactions and manifest-snapshots for the configured app dir', async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiny.cov-playwright-app-'))
  const outDir = path.join(appDir, '.shiny.cov')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(
    path.join(outDir, 'interactions-worker-0.json'),
    JSON.stringify([{ selector: '#go', action: 'click', value: null, timestamp: 1 }])
  )
  fs.writeFileSync(
    path.join(outDir, 'manifest-snapshots-worker-0.json'),
    JSON.stringify([{ inputs: [{ id: 'go', type: 'actionButton' }] }])
  )

  await globalTeardown({ projects: [{ use: { shinyCovAppDir: appDir } }] })

  assert.strictEqual(fs.existsSync(path.join(outDir, 'interactions.json')), true)
  assert.strictEqual(fs.existsSync(path.join(outDir, 'manifest-snapshots.json')), true)
})

test('resolveOutputDirs() dedupes across multiple projects sharing the same appDir', () => {
  const config = {
    projects: [
      { use: { shinyCovAppDir: 'app' } },
      { use: { shinyCovAppDir: 'app' } }
    ]
  }
  assert.strictEqual(resolveOutputDirs(config).length, 1)
})

test('resolveOutputDirs() falls back to SHINYCOV_APP_DIR when no project sets shinyCovAppDir', () => {
  process.env.SHINYCOV_APP_DIR = '/tmp/some-app'
  const dirs = resolveOutputDirs({ projects: [{ use: {} }] })
  assert.strictEqual(dirs.length, 1)
  assert.ok(dirs[0].endsWith(path.join('some-app', '.shiny.cov')))
})

test('warnIfWorkerCountLooksLow() warns when fewer distinct workers reported data than configured', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  warnIfWorkerCountLooksLow('/some/outDir', 4, [0, 1], [0])
  assert.strictEqual(warn.mock.callCount(), 1)
  assert.match(warn.mock.calls[0].arguments[0], /only 2 of up to 4 configured worker/)
})

test('warnIfWorkerCountLooksLow() does not warn when every configured worker reported data', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  warnIfWorkerCountLooksLow('/some/outDir', 2, [0, 1], [0, 1])
  assert.strictEqual(warn.mock.callCount(), 0)
})

test('warnIfWorkerCountLooksLow() does not warn when configuredWorkers is unknown or 1', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  warnIfWorkerCountLooksLow('/some/outDir', null, [], [])
  warnIfWorkerCountLooksLow('/some/outDir', 1, [], [])
  assert.strictEqual(warn.mock.callCount(), 0)
})

test('warnIfWorkerCountLooksLow() unions worker indices seen across both file kinds rather than requiring both to report the same worker', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  // Worker 1 logged only interactions (no manifest snapshot), worker 0
  // logged only a manifest snapshot (no interactions) -- together they
  // still account for both configured workers, so this is not a low count.
  warnIfWorkerCountLooksLow('/some/outDir', 2, [1], [0])
  assert.strictEqual(warn.mock.callCount(), 0)
})

test('globalTeardown() warns when the merged worker files look inconsistent with config.workers', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiny.cov-playwright-app-lowcount-'))
  const outDir = path.join(appDir, '.shiny.cov')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(
    path.join(outDir, 'interactions-worker-0.json'),
    JSON.stringify([{ selector: '#go', action: 'click', value: null, timestamp: 1 }])
  )

  await globalTeardown({ workers: 3, projects: [{ use: { shinyCovAppDir: appDir } }] })

  assert.strictEqual(warn.mock.callCount(), 1)
  assert.match(warn.mock.calls[0].arguments[0], /only 1 of up to 3 configured worker/)
})
