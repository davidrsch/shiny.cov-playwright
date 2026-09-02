// Exercises real Playwright multi-worker parallelism end to end -- the one
// property of this package's core design (per-worker file, flushed
// incrementally, merged by global-teardown.js) that the rest of the suite
// only ever simulates against pre-written files or a single worker.
//
// Runs the nested config in multi-worker/ (workers: 2, two independent
// spec files) as a real subprocess rather than as tests directly in this
// run, because the assertions below need to inspect the *merged* output
// files, which only exist once that nested run's own globalTeardown has
// completed -- not observable from a test inside the same run whose
// teardown hasn't happened yet.
'use strict'

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { test, expect } = require('../../src/fixtures.js')

const multiWorkerDir = path.join(__dirname, 'multi-worker')
const appDir = path.join(multiWorkerDir, '.tmp-app')
// @playwright/test's own package.json "exports" map doesn't expose cli.js
// as an importable subpath, so this resolves it via the installed .bin
// symlink's location rather than require.resolve().
const playwrightBin = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'playwright')

test('two real worker processes each flush their own file after their test, and globalTeardown merges both', async ({}, testInfo) => {
  testInfo.setTimeout(90000)

  fs.rmSync(appDir, { recursive: true, force: true })

  execFileSync(process.execPath, [playwrightBin, 'test', '-c', multiWorkerDir], {
    cwd: path.join(__dirname, '..', '..'),
    stdio: 'inherit'
  })

  const outDir = path.join(appDir, '.shiny.cov')

  const identityA = JSON.parse(fs.readFileSync(path.join(outDir, 'worker-a.identity.json'), 'utf8'))
  const identityB = JSON.parse(fs.readFileSync(path.join(outDir, 'worker-b.identity.json'), 'utf8'))
  // Proves this used two real OS processes, not just two spec files that
  // happened to share a single worker.
  expect(identityA.pid).not.toBe(identityB.pid)
  expect(identityA.workerIndex).not.toBe(identityB.workerIndex)
  const interactions = JSON.parse(fs.readFileSync(path.join(outDir, 'interactions.json'), 'utf8'))
  // worker-a.spec.js/worker-b.spec.js each run two tests; the second test in
  // each file directly asserts (mid-run, from inside the nested Playwright
  // process) that the first test's marker already reached that worker's
  // on-disk file before the second test started -- a property that depends
  // on flushing after every test, not only once at worker teardown. The
  // four markers surviving the merge here confirm both workers' data (both
  // tests each) made it through to the final file.
  for (const marker of ['#marker-a1', '#marker-a2', '#marker-b1', '#marker-b2']) {
    expect(interactions.some((e) => e.selector === marker)).toBe(true)
  }

  // Per-worker files are deleted once globalTeardown merges them.
  const leftoverWorkerFiles = fs.readdirSync(outDir).filter((f) => f.includes('-worker-'))
  expect(leftoverWorkerFiles.length).toBe(0)
})
