/**
 * shiny.cov-playwright — global teardown
 *
 * Runs once, after every worker has finished, in the main process --
 * Playwright's own precedent for this kind of "per-worker file, one merge
 * pass at the end" problem (its blob reporter does the identical shape for
 * test results). Globs each worker's interactions-worker-*.json and
 * manifest-snapshots-worker-*.json (written by fixtures.js's worker-scoped
 * fixtures, refreshed after every test), concatenates each set into one
 * file, and deletes the per-worker originals. Also warns (see
 * warnIfWorkerCountLooksLow()) when fewer workers reported data than the
 * run was configured to use, a possible sign one crashed before flushing
 * anything.
 *
 * interactions.json is written as a plain concatenated array, matching the
 * shape shinytest2.R's log_interaction()/shiny.cov-cypress's plugin.js
 * already produce ({selector, action, value, timestamp} per entry).
 * manifest-snapshots.json is written as a plain concatenated array too --
 * deliberately NOT merged here. Merging is now a read-time concern on the R
 * side (manifest_read_path()/read_manifest_from_path() in
 * shiny.cov-r/R/utils.R, reducing over merge_manifest_snapshots()), so this
 * adapter's write path stays "dumb accumulate" rather than a third
 * hand-copy of the merge algorithm shiny.cov-cypress's plugin.js and
 * shinytest2's AppDriver each already carry their own copy of.
 *
 * Register in playwright.config.ts:
 *
 *   module.exports = defineConfig({
 *     globalTeardown: require.resolve('shiny.cov-playwright/global-teardown'),
 *   })
 *
 * @module shiny.cov-playwright/global-teardown
 */

'use strict'

const fs = require('fs')
const path = require('path')

/**
 * Merge every `<prefix>-worker-*.json` array file in `outDir` into
 * `<finalName>`, then delete the per-worker files. A no-op if `outDir`
 * doesn't exist yet (no worker ever wrote anything, e.g. a run with zero
 * tests) or no matching files are found.
 * @param {string} outDir
 * @param {string} prefix
 * @param {string} finalName
 * @returns {number[]} The worker indices whose files were merged (empty
 *   when the merge was a no-op) -- used by warnIfWorkerCountLooksLow() to
 *   compare against the run's configured worker count.
 */
function mergeWorkerFiles(outDir, prefix, finalName) {
  if (!fs.existsSync(outDir)) return []
  const filePrefix = `${prefix}-worker-`
  const files = fs.readdirSync(outDir)
    .filter((f) => f.startsWith(filePrefix) && f.endsWith('.json'))
  if (files.length === 0) return []

  let merged = []
  // Only a file that actually parsed counts as "this worker reported
  // data" -- a worker killed mid-write can leave a corrupt-but-present
  // file behind, and warnIfWorkerCountLooksLow() needs to see that as
  // absent data, not as a worker that successfully reported.
  const workerIndices = []
  for (const file of files) {
    const full = path.join(outDir, file)
    const workerIndex = Number(file.slice(filePrefix.length, -'.json'.length))
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'))
      if (Array.isArray(parsed)) {
        merged = merged.concat(parsed)
        if (Number.isInteger(workerIndex)) workerIndices.push(workerIndex)
      }
    } catch (err) {
      console.error(
        `shiny.cov: failed to read/parse ${full} while merging -- skipping this file's entries:`,
        err.message
      )
    }
  }

  fs.writeFileSync(path.join(outDir, finalName), JSON.stringify(merged, null, 2))
  for (const file of files) {
    fs.unlinkSync(path.join(outDir, file))
  }
  return workerIndices
}

/**
 * Warns when fewer distinct workers reported data (across either file kind)
 * than the run was configured to use -- a heuristic signal, not proof of a
 * problem: a run with fewer test files than workers legitimately uses fewer
 * workers than configured, and a worker whose tests made zero interactions
 * legitimately writes no interactions file. It's still worth surfacing,
 * since the same signal is also what a worker crashing before it can flush
 * (see fixtures.js's per-test flush, which this backstops) would produce.
 * @param {string} outDir
 * @param {number|null|undefined} configuredWorkers `config.workers` from
 *   the `FullConfig` object passed into `globalTeardown`, or a falsy value
 *   when unknown/not applicable.
 * @param {number[]} interactionWorkers Worker indices returned by
 *   mergeWorkerFiles() for the `"interactions"` prefix.
 * @param {number[]} manifestWorkers Worker indices returned by
 *   mergeWorkerFiles() for the `"manifest-snapshots"` prefix.
 */
function warnIfWorkerCountLooksLow(outDir, configuredWorkers, interactionWorkers, manifestWorkers) {
  if (!configuredWorkers || configuredWorkers <= 1) return
  const seen = new Set([...interactionWorkers, ...manifestWorkers])
  if (seen.size < configuredWorkers) {
    console.warn(
      `shiny.cov: only ${seen.size} of up to ${configuredWorkers} configured worker(s) reported data in ${outDir}. ` +
      'This is expected when a run needs fewer workers than configured, but can also mean a worker crashed ' +
      'before flushing any data -- worth checking if this number looks lower than the run actually used.'
    )
  }
}

/**
 * Every `.shiny.cov` output directory in play for this run, deduped.
 * shinyCovAppDir is a per-project fixture option (see fixtures.js), so a
 * multi-project config could in principle target more than one app_dir --
 * handle that rather than assuming exactly one. Falls back to
 * SHINYCOV_APP_DIR (an env var, for a bare single-project setup with no
 * `use.shinyCovAppDir` configured) and finally `.` if neither is set,
 * matching fixtures.js's own `shinyCovAppDir` default.
 * @param {import('@playwright/test').FullConfig} config
 * @returns {string[]}
 */
function resolveOutputDirs(config) {
  const appDirs = new Set()
  for (const project of (config && config.projects) || []) {
    const appDir = project.use && project.use.shinyCovAppDir
    if (appDir) appDirs.add(appDir)
  }
  if (appDirs.size === 0) {
    appDirs.add(process.env.SHINYCOV_APP_DIR || '.')
  }
  return Array.from(appDirs, (appDir) => path.join(path.resolve(appDir), '.shiny.cov'))
}

/**
 * @param {import('@playwright/test').FullConfig} config
 */
module.exports = async function globalTeardown(config) {
  const configuredWorkers = config && typeof config.workers === 'number' ? config.workers : null
  for (const outDir of resolveOutputDirs(config)) {
    const interactionWorkers = mergeWorkerFiles(outDir, 'interactions', 'interactions.json')
    const manifestWorkers = mergeWorkerFiles(outDir, 'manifest-snapshots', 'manifest-snapshots.json')
    warnIfWorkerCountLooksLow(outDir, configuredWorkers, interactionWorkers, manifestWorkers)
  }
}

module.exports.mergeWorkerFiles = mergeWorkerFiles
module.exports.resolveOutputDirs = resolveOutputDirs
module.exports.warnIfWorkerCountLooksLow = warnIfWorkerCountLooksLow
