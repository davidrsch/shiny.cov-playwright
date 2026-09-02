/**
 * shiny.cov-playwright — UI manifest discovery
 *
 * Runs shiny.cov-r/inst/js/discover-bindings.js (vendored into
 * src/vendor/discover-bindings-source.js -- see
 * scripts/sync-discover-bindings.js) against a Playwright page, via
 * page.evaluate().
 *
 * @module shiny.cov-playwright/discover
 */

const discoverBindingsSource = require('./vendor/discover-bindings-source.js')

// Cypress's win.eval(source) runs `source` with indirect-eval script-body
// semantics -- the vendored file is a single expression statement (a
// self-invoking `(function () { ... })();`), and eval() returns the value
// of the last statement it ran, so win.eval() naturally hands back the
// manifest object. Playwright's page.evaluate() has no such "return the
// last statement's value" behavior for an arbitrary function body: a
// function only returns what it explicitly `return`s. A plain
// `return ${source}` doesn't work either, because the vendored file's own
// leading comments (`// shiny.cov UI discovery script...`) land right
// after `return` -- automatic semicolon insertion then reads that as a
// bare `return;` followed by unreachable code, silently discarding the
// manifest (caught by test/discover.test.js, which runs the wrapped
// function for real via node:vm rather than assuming the string is well
// formed). `(0, eval)(source)` -- indirect eval, the same global-scope
// semantics win.eval() relies on -- sidesteps this entirely: it evaluates
// `source` exactly as win.eval() does, comments and all, and its
// completion value becomes this function's `return` value.
const wrappedSource = `return (0, eval)(${JSON.stringify(discoverBindingsSource)})`

/**
 * Discover the live UI manifest from a Playwright page by asking the app's
 * own Shiny.inputBindings/Shiny.outputBindings registry what's actually
 * bound, exactly like the R/shinytest2 and Cypress adapters do.
 *
 * The vendored source is kept byte-identical to the canonical
 * shiny.cov-r/inst/js/discover-bindings.js -- the function-expression
 * wrapping page.evaluate() requires happens here, at the call site, not by
 * changing the vendored file or the sync script.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Object>} The discovered manifest
 *   ({inputs, outputs, tabs, conditional, modules}).
 */
async function discoverManifest(page) {
  return page.evaluate(new Function(wrappedSource))
}

module.exports = { discoverManifest }
