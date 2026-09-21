/**
 * Keeping a session alive across the moments it would otherwise die.
 *
 * Three things used to sign a working user out and lose the action they had
 * just taken (ASAP feedback, 2026-09):
 *
 *   1. Two tabs answering the same 401 with the same refresh cookie. The first
 *      rotated the token; the second replayed a rotated-out one, which the
 *      server read as compromise and wiped every session.
 *   2. A refresh that failed for a transient reason — the network dropped, the
 *      API restarted, a rate limit — was treated like a refused one: straight
 *      to the login page.
 *   3. The request that triggered the refresh was rejected along with it.
 *
 * This module owns the refresh so those cannot happen from the client side:
 *
 *   - `refreshSession()` runs at most one refresh per browser at a time (Web
 *     Locks API across tabs, a shared promise within one). A tab that waited
 *     for the lock checks whether another tab already refreshed meanwhile —
 *     the CSRF cookie is JS-readable and rotates with every mint, so a change
 *     in it means "done, just retry" — and skips its own refresh.
 *   - A transient failure is retried with backoff for up to ~30 s while
 *     `reconnecting` is true, so the shell can say "Reconnecting…". Only a
 *     definitive refusal (401/403 from the refresh endpoint) gives up.
 *   - The caller (the api interceptor) awaits the same promise for every
 *     request that hit the 401, then replays them all.
 *
 * The server does its part too: a replay within seconds of a rotation is
 * rejected without wiping the chain (auth.service ROTATION_RACE_WINDOW_MS).
 */
import { ref } from 'vue'
import authService from '@/services/auth.service'

const CSRF_COOKIE_RE = /(?:^|; )asap_kr_csrf=([^;]+)/
const LOCK_NAME = 'asap-kr-session-refresh'
// 1 s, 2 s, 4 s, 8 s, 16 s — about half a minute of patience, and comfortably
// under the refresh endpoint's rate limit (10 / min).
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]

/** True while a refresh is being retried after a transient failure. */
export const reconnecting = ref(false)

let inFlight = null

function readCsrf() {
  if (typeof document === 'undefined') return null
  const m = document.cookie.match(CSRF_COOKIE_RE)
  return m ? m[1] : null
}

/** A refusal is final; anything else (no response, 5xx, 429) may pass. */
export function isDefinitiveRefusal(err) {
  const status = err?.response?.status
  return status === 401 || status === 403
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One refresh attempt, retried on transient failure. Resolves when the
 * cookies are fresh; rejects only on a definitive refusal or after the
 * last retry.
 */
async function refreshWithRetries() {
  let attempt = 0
  for (;;) {
    try {
      const result = await authService.refreshToken()
      reconnecting.value = false
      return result
    } catch (err) {
      if (isDefinitiveRefusal(err) || attempt >= RETRY_DELAYS_MS.length) {
        reconnecting.value = false
        throw err
      }
      reconnecting.value = true
      await sleep(RETRY_DELAYS_MS[attempt])
      attempt += 1
    }
  }
}

/**
 * Run `fn` under the cross-tab lock when the browser has one; otherwise just
 * run it (the server-side race window still covers that browser).
 */
async function withCrossTabLock(fn) {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : null
  if (locks?.request) return locks.request(LOCK_NAME, fn)
  return fn()
}

/**
 * Refresh the session, once, for everyone who asks while it is happening.
 *
 * @returns {Promise<void>} resolves when the session cookies are fresh
 */
export function refreshSession() {
  if (inFlight) return inFlight
  const csrfBefore = readCsrf()
  inFlight = withCrossTabLock(async () => {
    // Another tab may have refreshed while we waited for the lock; the CSRF
    // cookie rotates with every mint, so a change means the work is done.
    if (csrfBefore && readCsrf() !== csrfBefore) return
    await refreshWithRetries()
  }).finally(() => { inFlight = null })
  return inFlight
}

/** Test hook: forget an in-flight refresh. */
export function _resetForTests() {
  inFlight = null
  reconnecting.value = false
}
