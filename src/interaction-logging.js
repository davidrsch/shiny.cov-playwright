/**
 * shiny.cov-playwright — Proxy-based interaction logging
 *
 * Wraps a Playwright `page` (or a `Locator` derived from one) in a `Proxy`
 * that observes real method calls and appends a log entry for each
 * recognized one, without altering behavior: every call still goes through
 * to the real Playwright method (`value.apply(target, args)`, preserving
 * `this`), so auto-wait/retry/tracing -- which live inside those real
 * methods -- are untouched. See fixtures.js for where this gets wired into
 * the `page` fixture override.
 *
 * @module shiny.cov-playwright/interaction-logging
 */

'use strict'

// Kept in sync with shinycov_input_actions()/shinycov_output_actions()
// in shiny.cov-r/R/utils.R -- these are the exact strings this module emits
// as `action`, not a speculative list; extend both sides together.
const INPUT_ACTIONS = new Set([
  'click', 'dblclick', 'tap', 'check', 'uncheck', 'fill', 'type', 'press',
  'pressSequentially', 'selectOption', 'setInputFiles', 'dragTo', 'clear',
  'selectText', 'focus', 'hover'
])
const OUTPUT_ACTIONS = new Set([
  'textContent', 'innerText', 'innerHTML', 'getAttribute', 'inputValue'
])
const LOGGED_ACTIONS = new Set([...INPUT_ACTIONS, ...OUTPUT_ACTIONS])

// These take no meaningful "value" beyond an options bag (e.g.
// click({ force: true })) -- logging that bag as `value` would be noise
// from Playwright's own API surface, not a value a test author supplied.
const NO_VALUE_ACTIONS = new Set([
  'click', 'dblclick', 'tap', 'check', 'uncheck', 'focus', 'hover',
  'clear', 'selectText'
])

/**
 * Duck-types a Playwright `Locator` rather than checking
 * `instanceof`/constructor name, since the real class isn't imported here
 * (this module has no direct dependency on `@playwright/test`, only on
 * whatever object shape it's handed) and a Proxy-wrapped Locator's
 * `constructor` still resolves correctly through the default (unoverridden)
 * `getPrototypeOf` trap anyway -- duck-typing works for both wrapped and
 * unwrapped alike.
 * @param {*} value
 * @returns {boolean}
 */
function looksLikeLocator(value) {
  return !!value && typeof value === 'object' &&
    typeof value.click === 'function' &&
    typeof value.fill === 'function' &&
    typeof value.locator === 'function'
}

/**
 * Duck-types a Playwright `FrameLocator`, the object `page.frameLocator()`
 * returns. Its surface is narrower than `Locator`'s -- `.locator()`,
 * `.frameLocator()`, `.owner()`, no `.click()`/`.fill()` -- so it fails
 * `looksLikeLocator()` and needs its own check to be recognized and
 * recursively wrapped rather than handed back raw.
 * @param {*} value
 * @returns {boolean}
 */
function looksLikeFrameLocator(value) {
  return !!value && typeof value === 'object' &&
    typeof value.click !== 'function' &&
    typeof value.locator === 'function' &&
    typeof value.frameLocator === 'function'
}

// Locator-returning methods whose own call arguments identify *what* they
// found (a role, label text, test id, ...) rather than a literal CSS/XPath
// selector string. Synthesizing a description from those arguments gives
// downstream manifest-matching a real, human-readable identifier instead of
// inheriting the parent's selector unchanged -- which for a chain rooted at
// `page` would otherwise mean carrying `page`'s own `selector: null` all the
// way down, making a `getByRole()`-derived Locator indistinguishable from
// the page root itself.
const LOCATOR_FACTORY_METHODS = new Set([
  'getByRole', 'getByLabel', 'getByText', 'getByTestId',
  'getByPlaceholder', 'getByAltText', 'getByTitle'
])

/**
 * Renders a `getBy*()` matcher argument (a string or `RegExp`) as text
 * suitable for a synthesized selector description.
 * @param {*} value
 * @returns {string}
 */
function describeMatcher(value) {
  return value instanceof RegExp ? value.toString() : String(value)
}

/**
 * Synthesizes a human-readable description for a `getBy*()` call, e.g.
 * `getByRole('button', {name: 'Submit'})` -> `role=button[name="Submit"]`,
 * `getByLabel('Name')` -> `label=Name`. Not a real CSS/XPath selector --
 * just a stable, non-null identifier built from the call's own arguments,
 * used as the child Locator's `selector` in place of blindly inheriting the
 * parent's.
 * @param {string} propName One of LOCATOR_FACTORY_METHODS.
 * @param {Array} callArgs
 * @returns {string|null}
 */
function synthesizeGetByDescription(propName, callArgs) {
  const [arg0, options] = callArgs
  switch (propName) {
    case 'getByRole': {
      const name = options && options.name !== undefined
        ? `[name="${describeMatcher(options.name)}"]`
        : ''
      return `role=${arg0}${name}`
    }
    case 'getByLabel':
      return `label=${describeMatcher(arg0)}`
    case 'getByText':
      return `text=${describeMatcher(arg0)}`
    case 'getByTestId':
      return `testid=${describeMatcher(arg0)}`
    case 'getByPlaceholder':
      return `placeholder=${describeMatcher(arg0)}`
    case 'getByAltText':
      return `alt=${describeMatcher(arg0)}`
    case 'getByTitle':
      return `title=${describeMatcher(arg0)}`
    default:
      return null
  }
}

/**
 * Computes the selector to propagate to a re-wrapped child Locator/
 * FrameLocator, given the call that produced it. `.locator(cssString)` and
 * `.frameLocator(cssString)` use their own literal selector argument;
 * `getBy*()` methods get a synthesized description (see
 * `synthesizeGetByDescription`); everything else that narrows an existing
 * Locator without identifying anything new of its own -- `.filter()`,
 * `.first()`, `.nth()`, `.and()`, `.or()`, `.owner()` -- inherits the
 * parent's selector unchanged, since it doesn't need one of its own.
 * @param {string} propName
 * @param {Array} callArgs
 * @param {string|null} selector The parent's selector.
 * @returns {string|null}
 */
function childSelectorFor(propName, callArgs, selector) {
  let description = null
  if (propName === 'locator' && typeof callArgs[0] === 'string') {
    description = callArgs[0]
  } else if (propName === 'frameLocator') {
    description = typeof callArgs[0] === 'string' ? `frame=${callArgs[0]}` : 'frame'
  } else if (LOCATOR_FACTORY_METHODS.has(propName)) {
    description = synthesizeGetByDescription(propName, callArgs)
  }
  if (description === null) return selector
  return selector ? `${selector} >> ${description}` : description
}

/**
 * Best-effort extraction of the "value" argument for a logged action, e.g.
 * the text passed to `fill()`. Not attempted for NO_VALUE_ACTIONS. When the
 * call's first argument was itself consumed as the selector (a page-level
 * call like `page.fill(selector, value)`, not a Locator-bound one), the
 * value is the *second* argument instead.
 * @param {string} action
 * @param {Array} args
 * @param {boolean} consumedSelectorArg
 * @returns {*} A JSON-safe value, or `null` if none/unavailable.
 */
function pickValue(action, args, consumedSelectorArg) {
  if (NO_VALUE_ACTIONS.has(action)) return null
  const rest = consumedSelectorArg ? args.slice(1) : args
  const first = rest[0]
  if (first === undefined) return null
  if (typeof first === 'string' || typeof first === 'number' || typeof first === 'boolean') {
    return first
  }
  if (Array.isArray(first)) return first
  if (first !== null && typeof first === 'object') {
    // Structured value (e.g. selectOption({ label }), a files array with
    // {name, mimeType, buffer} entries) rather than necessarily an options
    // bag -- still worth capturing. A JSON round-trip drops anything
    // non-serializable (e.g. a Locator passed to dragTo()) instead of
    // throwing.
    try {
      return JSON.parse(JSON.stringify(first))
    } catch (err) {
      return null
    }
  }
  return null
}

/**
 * Wrap `target` (a `page`, `Locator`, or `FrameLocator`) in a logging Proxy.
 *
 * `selector` is the identifying string already known for `target` (`null`
 * for the root `page`, since it has no selector of its own, or for a
 * Locator/FrameLocator that genuinely hasn't been given one yet). `isPageRoot`
 * is tracked as its own flag, separate from `selector`, because both the
 * page root and a fresh `getBy*()`-derived Locator can legitimately have
 * `selector === null` -- only the page root's calls take a selector as their
 * own first argument (`page.click(selector)`), so the "treat the first
 * string argument as an implicit selector" heuristic below must key off
 * `isPageRoot`, not off `selector` being unset.
 *
 * Locator/FrameLocator-returning methods (`.locator()`, `.filter()`,
 * `.first()`, `.nth()`, `.and()`, `.or()`, `.getByRole()`, `.frameLocator()`,
 * ...) return a NEW real object each call -- a shallow Proxy only intercepts
 * calls on the exact object it wraps, so without re-wrapping, a chained call
 * like `page.locator('#list').filter({...}).click()` would silently stop
 * being logged after `.filter()`. Detecting via `looksLikeLocator()`/
 * `looksLikeFrameLocator()` (duck typing the return value, not hardcoding
 * every such method name) and recursively wrapping it here -- always with
 * `isPageRoot: false`, since only the actual page object is the page root --
 * is what keeps the whole chain logged.
 *
 * @param {*} target
 * @param {string|null} selector
 * @param {Array<Object>} log Entries are pushed here as
 *   `{selector, action, value, timestamp}`.
 * @param {boolean} [isPageRoot] Whether `target` is the actual `page` object.
 * @returns {*} A Proxy around `target`.
 */
function wrapWithLogging(target, selector, log, isPageRoot = false) {
  return new Proxy(target, {
    get(obj, prop) {
      const value = obj[prop]
      if (typeof value !== 'function') return value

      return function shinyCovWrappedMethod(...args) {
        const result = value.apply(obj, args)
        if (result && typeof result.then === 'function') {
          return result.then((resolved) => afterCall(prop, args, resolved))
        }
        return afterCall(prop, args, result)
      }

      function afterCall(propName, callArgs, result) {
        const consumedSelectorArg = isPageRoot &&
          typeof callArgs[0] === 'string' &&
          LOGGED_ACTIONS.has(propName)
        const effectiveSelector = selector || (consumedSelectorArg ? callArgs[0] : null)

        if (LOGGED_ACTIONS.has(propName)) {
          log.push({
            selector: effectiveSelector,
            action: propName,
            value: pickValue(propName, callArgs, consumedSelectorArg),
            timestamp: Date.now()
          })
        }

        if (looksLikeLocator(result) || looksLikeFrameLocator(result)) {
          const childSelector = childSelectorFor(propName, callArgs, selector)
          return wrapWithLogging(result, childSelector, log, false)
        }

        return result
      }
    }
  })
}

module.exports = {
  INPUT_ACTIONS,
  OUTPUT_ACTIONS,
  LOGGED_ACTIONS,
  NO_VALUE_ACTIONS,
  looksLikeLocator,
  looksLikeFrameLocator,
  pickValue,
  wrapWithLogging
}
