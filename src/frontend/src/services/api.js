import axios from 'axios'
import { useAuthStore } from '@/stores/auth.store'
import router from '@/router'

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

// Single in-flight refresh promise so two parallel 401s issue ONE
// /auth/refresh call and both retry against the same new session.
let refreshPromise = null

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

// Response interceptor — handle 401s by attempting a single refresh.
api.interceptors.response.use(
  (response) => response,
  async (error) => {
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

      const authStore = useAuthStore()
      try {
        // De-dupe parallel refresh attempts: only the first 401 actually
        // hits /auth/refresh; the rest await the same promise.
        if (!refreshPromise) {
          refreshPromise = authStore.refreshAccessToken()
            .finally(() => { refreshPromise = null })
        }
        await refreshPromise

        // Cookies are already updated on the response — just retry. No
        // header rewriting needed (auth travels on the cookie now).
        return api(originalRequest)
      } catch (refreshError) {
        // Refresh failed — drop user state and bounce to login.
        await authStore.clearAuth()
        router.push({ name: 'login' })
        return Promise.reject(refreshError)
      }
    }

    return Promise.reject(error)
  }
)

export default api
