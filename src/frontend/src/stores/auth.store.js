import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import authService from '@/services/auth.service'

export const useAuthStore = defineStore('auth', () => {
  // ── State ────────────────────────────────────────────────────────
  //
  // Phase 6: tokens live in HttpOnly cookies. The store only tracks the
  // user object (returned by /auth/login or /auth/me). isAuthenticated
  // becomes "we have a user" — if the cookies have expired the next
  // request will 401 and the axios interceptor will refresh-or-bounce.
  const user = ref(null)
  const loading = ref(false)
  const error = ref(null)
  const viewAsRole = ref(null) // Admin-only: simulate viewing UI as another role

  // Getters
  const isAuthenticated = computed(() => !!user.value)
  const userRole = computed(() => user.value?.role || null)
  const userTeams = computed(() => user.value?.teams || [])

  // Real admin check (not affected by viewAsRole)
  const isRealAdmin = computed(() => userRole.value === 'admin')

  // Effective role for UI display (affected by viewAsRole for admins)
  const effectiveRole = computed(() => {
    if (isRealAdmin.value && viewAsRole.value) {
      return viewAsRole.value
    }
    return userRole.value
  })

  // Auth0 user check. The backend's `User.toJSON()` strips the raw `auth0Sub`
  // claim before sending the user object to the client and replaces it with
  // the boolean `isAuth0User` flag — read from the flag here, not the stripped
  // field, otherwise this always evaluates to false.
  const isAuth0User = computed(() => !!user.value?.isAuth0User)

  // Permission checks use effectiveRole for UI simulation
  const canCreateSubmission = computed(() => !!user.value)
  const isAdmin = computed(() => effectiveRole.value === 'admin')
  const isStaff = computed(() => ['admin', 'ds_annotator'].includes(effectiveRole.value))
  const canManageUsers = computed(() => isStaff.value)
  const canViewUsers = computed(() => ['admin', 'ds_annotator', 'asap_pm'].includes(effectiveRole.value))
  const canManageTeams = computed(() => isStaff.value)
  // Team-email roster: staff plus PMs, who maintain their own team's roster.
  const canManageTeamEmails = computed(() => ['admin', 'ds_annotator', 'asap_pm'].includes(effectiveRole.value))

  // Submission lifecycle
  const canDeleteSubmission = computed(() => isStaff.value)
  // Hide/unhide is the author's "delete" proxy — available to everyone
  const canHideSubmission = computed(() => !!user.value)

  // Job internals: hidden from authors only. PM, ds_annotator, admin all see
  // raw logs and responses (for debugging pipeline behavior).
  const canViewJobInternals = computed(() =>
    !!effectiveRole.value && effectiveRole.value !== 'author'
  )
  // Manual job lifecycle actions (advance, restart, retry): staff only.
  const canManageJobs = computed(() => isStaff.value)

  // User admin: ds_annotator may edit non-admin users; only admin touches admins.
  const canEditAnyUser = computed(() => isStaff.value)
  const canEditAdminUsers = computed(() => effectiveRole.value === 'admin')
  const canDeleteUsers = computed(() => effectiveRole.value === 'admin')

  // Reference data management
  const canManageEnrichments = computed(() => isStaff.value)
  const canManageResourceTypes = computed(() => isStaff.value)
  const canManageValidationRules = computed(() => effectiveRole.value === 'admin')

  /**
   * Per-submission edit check. Authors edit only their own; staff edit
   * anything; a PM edits any submission they can see (the server only lists
   * submissions whose owner shares one of the PM's teams, and re-enforces on
   * write — the owner's teams aren't sent to the client to check here).
   * Mirrors backend canAccessSubmission for write access.
   */
  function canEditSubmission(submission) {
    if (!user.value || !submission) return false
    const role = effectiveRole.value
    if (role === 'admin' || role === 'ds_annotator') return true
    if (role === 'author') return submission.userId === user.value.id
    if (role === 'asap_pm') return true
    return false
  }

  // ── Actions ──────────────────────────────────────────────────────

  async function login(email, password) {
    loading.value = true
    error.value = null

    try {
      const response = await authService.login(email, password)
      setAuth(response)
      return response
    } catch (err) {
      error.value = err.response?.data?.error || 'Login failed'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function auth0PasswordLogin(email, password) {
    loading.value = true
    error.value = null

    try {
      const response = await authService.auth0PasswordLogin(email, password)
      setAuth(response)
      return response
    } catch (err) {
      error.value = err.response?.data?.error || 'Login failed'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function register(userData) {
    loading.value = true
    error.value = null

    try {
      const response = await authService.register(userData)
      setAuth(response)
      return response
    } catch (err) {
      error.value = err.response?.data?.error || 'Registration failed'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function logout() {
    let auth0LogoutUrl = null

    // The server-side logout revokes EVERY refresh token for this user
    // (global logout — confirmed during audit review). It also clears the
    // session/refresh/CSRF cookies on the response. We always call it,
    // even if we think we're not authenticated, so any stale cookies on
    // the browser get invalidated.
    try {
      const data = await authService.logout()
      auth0LogoutUrl = data?.auth0LogoutUrl || null
    } catch (err) {
      // Ignore logout errors — we still clear local state
    }

    clearAuth()

    // Auth0-linked users: redirect to Auth0 /v2/logout to terminate the
    // upstream session. Auth0 will redirect back to ${FRONTEND_URL}/login.
    if (auth0LogoutUrl) {
      window.location.href = auth0LogoutUrl
    }
  }

  async function fetchCurrentUser() {
    try {
      const response = await authService.getCurrentUser()
      user.value = response.user
      return response.user
    } catch (err) {
      clearAuth()
      throw err
    }
  }

  /**
   * Trigger a server-side refresh. The backend reads the refresh cookie,
   * mints a new JWT pair, and Set-Cookies them on the response — we never
   * see the tokens. Returns the response data (contains a status message
   * but no tokens).
   */
  async function refreshAccessToken() {
    try {
      return await authService.refreshToken()
    } catch (err) {
      clearAuth()
      throw err
    }
  }

  function setAuth(response) {
    user.value = response.user
  }

  /**
   * Clear local user state. The server-side cookies are cleared by
   * /auth/logout; if we were called from the 401-retry path (refresh
   * failed), the cookies are already toast on the server side — there's
   * nothing for the SPA to clean up.
   */
  function clearAuth() {
    user.value = null
    viewAsRole.value = null
  }

  // Check if user can access a submission (uses effectiveRole for UI
  // simulation). Same as canEditSubmission: staff all; author own; a PM can
  // access anything the server lists for them (owner shares one of their teams).
  function canAccessSubmission(submission) {
    if (!user.value) return false
    if (effectiveRole.value === 'admin' || effectiveRole.value === 'ds_annotator') return true
    if (effectiveRole.value === 'author') return submission.userId === user.value.id
    if (effectiveRole.value === 'asap_pm') return true
    return false
  }

  // Admin-only: Set viewing role for UI debugging
  function setViewAsRole(role) {
    if (isRealAdmin.value) {
      viewAsRole.value = role
    }
  }

  // Clear the viewing role
  function clearViewAsRole() {
    viewAsRole.value = null
  }

  /**
   * Try to fetch the current user. The session cookie travels automatically;
   * if it's missing or invalid, the call 401s and clearAuth() runs. The
   * router-level guard then bounces to /login on the next gated route.
   *
   * Replaces the previous handleAuth0Callback flow — the backend's
   * /api/auth/callback now sets cookies on the redirect response and
   * redirects to /dashboard with no URL-hash tokens.
   */
  async function initialize() {
    try {
      await fetchCurrentUser()
    } catch (err) {
      // 401: no valid session cookie. Stay logged out; the router handles
      // the redirect to /login.
    }
  }

  return {
    // State
    user,
    loading,
    error,
    viewAsRole,
    // Getters
    isAuthenticated,
    userRole,
    userTeams,
    effectiveRole,
    isRealAdmin,
    canCreateSubmission,
    isAdmin,
    isStaff,
    isAuth0User,
    canManageUsers,
    canViewUsers,
    canManageTeams,
    canManageTeamEmails,
    canDeleteSubmission,
    canHideSubmission,
    canViewJobInternals,
    canManageJobs,
    canEditAnyUser,
    canEditAdminUsers,
    canDeleteUsers,
    canManageEnrichments,
    canManageResourceTypes,
    canManageValidationRules,
    // Actions
    login,
    auth0PasswordLogin,
    register,
    logout,
    fetchCurrentUser,
    refreshAccessToken,
    canAccessSubmission,
    canEditSubmission,
    setViewAsRole,
    clearViewAsRole,
    clearAuth,
    initialize
  }
})
