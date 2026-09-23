import axios from 'axios'
import { useAuthStore } from '@/stores/auth.store'
import router from '@/router'
import { refreshSession, isDefinitiveRefusal, reconnecting } from '@/services/session-reconnect'

// ── Cookie-based auth (Phase 6) ────────────────────────────────────
//
// The local-JWT session lives in three backend-set cookies:
//   asap_kr_session  — access JWT (HttpOnly, Path=/api)
//   asap_kr_refresh  — refresh JWT (HttpOnly, Path=/api/auth/refresh)
//   asap_kr_csrf     — CSRF double-submit token (JS-readable, Path=/)
//
// withCredentials:true tells axios to send these cookies on every request
// AND to honour Set-Cookie on responses. The frontend never touches the
// access/refresh tokens — they're HttpOnly. The CSRF token is the only
// JS-readable one and we send it as the X-CSRF-Token header on every
// state-changing request.
const CSRF_COOKIE = 'asap_kr_csrf'
const CSRF_COOKIE_RE = new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]+)`)

function readCsrfToken() {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(CSRF_COOKIE_RE)
  return match ? decodeURIComponent(match[1]) : null
}

const api = axios.create({
  baseURL: '/api',
  timeout: 30000, // 30 seconds default timeout
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json'
  }
})

// A request that never reached the server (network drop, API restart) is
// retried a few times before it fails. Uploads are excluded: a multipart
// body is not safely replayable. Backoff stays short — this covers a blip,
// not an outage.
const NETWORK_RETRY_DELAYS_MS = [1000, 3000, 8000]
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function isNetworkFailure(error) {
  return !error.response && (error.code === 'ERR_NETWORK' || error.code === 'ECONNABORTED' || error.message === 'Network Error')
}

function isMultipartBody(data) {
  // Duck-typed on purpose: the FormData a component builds and the one this
  // module's global names can be different constructors (test runtimes,
  // iframes), and a multipart body must never be replayed blind.
  return !!data && typeof data === 'object'
    && typeof data.append === 'function' && typeof data.getAll === 'function'
}

function isReplayable(config) {
  if (!config) return false
  if (isMultipartBody(config.data)) return false
  return !String(config.url || '').includes('/auth/')
}

// Request interceptor — inject CSRF token on state-changing requests.
// (Auth itself rides on the cookies, no header needed.)
api.interceptors.request.use(
  (config) => {
    const method = (config.method || 'get').toLowerCase()
    if (['post', 'patch', 'put', 'delete'].includes(method)) {
      const csrf = readCsrfToken()
      if (csrf) {
        config.headers['X-CSRF-Token'] = csrf
      }
    }
    return config
  },
  (error) => Promise.reject(error)
)

/**
 * Put the reason back into a validation error's message.
 *
 * A 400 from the API names the offending field in `details` — `{ field:
 * 'password', message: '"password" length must be at least 8 characters long' }`
 * — while `data.error` is only **"Validation failed"**. Over a hundred call
 * sites read `data.error` and drop `details` on the floor, so an admin
 * creating a user was told "Validation failed" and nothing else, with no way
 * to learn which field was wrong (reported 2026-09-22).
 *
 * Folding the detail in here fixes every one of those call sites at once. The
 * leading `"field"` Joi repeats is stripped, because the field name is already
 * printed in front of it. `details` is left untouched for the handful of
 * components that render it themselves.
 *
 * @param {object} error - an axios error
 */
function describeValidationError(error) {
  const data = error?.response?.data
  if (!data || data._described || typeof data.error !== 'string') return
  if (!Array.isArray(data.details) || data.details.length === 0) return

  const parts = data.details.map((detail) => {
    const field = String(detail?.field || '').trim()
    const message = String(detail?.message || '')
      .replace(/^"[^"]*"\s*/, '')   // Joi repeats the field name in quotes
      .trim()
    if (!message) return field || ''
    return field ? `${field}: ${message}` : message
  }).filter(Boolean)

  if (!parts.length) return
  data.error = `${data.error} — ${parts.join('; ')}`
  // Marked so a retried request cannot append the same detail twice.
  data._described = true
}

// Response interceptor — keep the session alive across a 401 and a blip.
//
// A 401 on an ordinary request means the access token expired: refresh the
// session (one refresh for every request that hit it, across tabs — see
// session-reconnect.js) and replay the request. Only a definitive refusal
// of the refresh itself sends the user to the login page; a refresh that
// failed for a transient reason leaves them where they are, still signed
// in as far as the app knows, and the next action tries again (ASAP,
// 2026-09: "manage the disconnect silently, apply the changes once the app
// has reconnected").
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    describeValidationError(error)
    const originalRequest = error.config

    // Skip retry for explicit auth endpoints to avoid loops:
    //   /auth/logout: don't try to "fix" a logout that 401'd
    //   /auth/refresh: a 401 here means the refresh cookie is invalid;
    //                  bouncing into another refresh would loop
    const url = originalRequest?.url || ''
    if (
      error.response?.status === 401 &&
      !originalRequest?._retry &&
      !url.includes('/auth/logout') &&
      !url.includes('/auth/refresh')
    ) {
      originalRequest._retry = true

      try {
        await refreshSession()
        // Cookies are already updated on the response — just retry. No
        // header rewriting needed (auth travels on the cookie now).
        return api(originalRequest)
      } catch (refreshError) {
        if (!isDefinitiveRefusal(refreshError)) {
          // Transient: the session may well be fine. Fail this request
          // without touching auth state; the next action retries.
          return Promise.reject(refreshError)
        }
        // Refused — drop user state and bounce to login, keeping the
        // current location so login can return the user where they were
        // (mirrors the router guard's redirect handling).
        useAuthStore().clearAuth()
        router.push({
          name: 'login',
          query: { redirect: router.currentRoute.value.fullPath }
        })
        return Promise.reject(refreshError)
      }
    }

    // Never reached the server: retry with backoff while the shell says
    // "Reconnecting…". A write the server did process but whose response
    // was lost is replayed too — the batch cell update is idempotent and
    // the suggestion endpoints refuse a double accept, so the cost is a
    // refused retry, not a duplicate.
    if (isNetworkFailure(error) && isReplayable(originalRequest)) {
      const attempt = originalRequest._networkRetries || 0
      if (attempt < NETWORK_RETRY_DELAYS_MS.length) {
        originalRequest._networkRetries = attempt + 1
        reconnecting.value = true
        await sleep(NETWORK_RETRY_DELAYS_MS[attempt])
        try {
          const response = await api(originalRequest)
          reconnecting.value = false
          return response
        } catch (retryError) {
          if (!isNetworkFailure(retryError)) reconnecting.value = false
          return Promise.reject(retryError)
        }
      }
      reconnecting.value = false
    }

    return Promise.reject(error)
  }
)

export default api
// For tests: the replay predicate and the validation-message helper, without
// driving a request through axios.
export { isReplayable, describeValidationError }
