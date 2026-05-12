# Auth0 Integration — ASAP KR-Sync

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Configuration](#configuration)
4. [Authentication Flows](#authentication-flows)
   - [Auth0 Social Login (Google / ORCID)](#auth0-social-login-google--orcid)
   - [Auth0 Password Login](#auth0-password-login)
   - [Local (DataSeer) Login](#local-dataseer-login)
   - [Auth0 Callback Processing](#auth0-callback-processing)
5. [User Account Lifecycle](#user-account-lifecycle)
   - [Auto-creation on First Login](#auto-creation-on-first-login)
   - [Account Linking by Email](#account-linking-by-email)
   - [Auth0 vs Local Users](#auth0-vs-local-users)
6. [Backend Implementation Details](#backend-implementation-details)
   - [Auth0 Service](#auth0-service)
   - [Dual-Strategy Auth Middleware](#dual-strategy-auth-middleware)
   - [Auth0 Controller Methods](#auth0-controller-methods)
   - [Auth0 Routes](#auth0-routes)
   - [User Model Changes](#user-model-changes)
   - [Profile Protection](#profile-protection)
7. [Frontend Implementation Details](#frontend-implementation-details)
   - [Login View (Tabbed UI)](#login-view-tabbed-ui)
   - [Auth Store](#auth-store)
   - [Auth Service](#auth-service)
   - [Router Guard](#router-guard)
   - [API Interceptor](#api-interceptor)
   - [Profile View](#profile-view)
8. [Database Migration](#database-migration)
9. [API Reference](#api-reference)
10. [Security Considerations](#security-considerations)
11. [Troubleshooting](#troubleshooting)
12. [Testing Checklist](#testing-checklist)

---

## Overview

ASAP KR-Sync supports **dual authentication**: existing local (DataSeer) email/password accounts coexist alongside Auth0-managed ASAP Hub identities. The integration allows ASAP users to sign in via their institutional identity provider (Google, ORCID, or Auth0 username/password) without needing to create a separate KR-Sync account.

### Key Design Decisions

| Decision | Rationale |
|---|---|
| **Server-side identity bridge** | All Auth0 communication happens on the backend. The frontend is fully decoupled from Auth0 — no Auth0 SDK on the client. |
| **Local JWT tokens for all users** | After Auth0 authentication, the backend issues its own local JWT tokens. This keeps the token format uniform and allows the existing middleware to work unchanged. |
| **Preserve existing auth** | Non-ASAP users continue to use the local DataSeer email/password flow. No migration required. |
| **Auto-create on first login** | Auth0 users get a local `User` record automatically. No admin action needed. |
| **Account linking by email** | If an Auth0 user's email matches an existing local user, the accounts are linked via `auth0Sub`. No duplicate accounts. |
| **Auth0 users can't change password locally** | Their password is managed by the identity provider. The profile page hides the password form. |
| **HttpOnly cookies for the local JWT pair** | Since phase 6 the access + refresh tokens are delivered via `HttpOnly; Secure; SameSite=Strict` cookies, not the response body or the URL hash. The SPA never sees them. CSRF is enforced via a double-submit token (cookie + `X-CSRF-Token` header). |

> **⚠ Contracted design — do not remove.** The Auth0 application config and
> the three authentication routes (`/api/auth/auth0/login` social-login
> redirect, `/api/auth/auth0/login-password` ROPG proxy, and
> `/api/auth/callback`) are part of the integration contract with ASAP.
> The `/api/auth/auth0/login-password` route in particular is the ASAP
> Hub login form's email/password path; ASAP has explicitly enabled the
> Password grant on the application for this purpose. Removing or
> renaming any of the three would break the contracted login UX.
> Hardening (rate limiting, brute-force protection at the tenant level,
> short access-token TTL) is what we own; the route shapes are not.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         Frontend (Vue.js)                        │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │                    Login View                            │    │
│  │  ┌─────────────────┐  ┌────────────────────────────┐    │    │
│  │  │   ASAP Hub Tab   │  │   DataSeer Tab             │    │    │
│  │  │                  │  │                            │    │    │
│  │  │ Email/Password   │  │ Email/Password             │    │    │
│  │  │ ──────────────── │  │ Register link              │    │    │
│  │  │ Google button    │  │                            │    │    │
│  │  │ ORCID button     │  │                            │    │    │
│  │  └─────────────────┘  └────────────────────────────┘    │    │
│  └──────────────────────────────────────────────────────────┘    │
└──────────────────┬────────────────────────────┬──────────────────┘
                   │                            │
    Social login   │       Password login       │  Local login
    (redirect)     │       (POST)               │  (POST)
                   │                            │
┌──────────────────▼────────────────────────────▼──────────────────┐
│                       Backend (Express.js)                        │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    Auth Routes                               │ │
│  │                                                              │ │
│  │  GET  /auth/auth0/login          → Redirect to Auth0        │ │
│  │  GET  /auth/auth0/callback       → Exchange code, redirect  │ │
│  │  POST /auth/auth0/login-password → Proxy to Auth0           │ │
│  │  POST /auth/login                → Local verification       │ │
│  │  POST /auth/register             → Local registration       │ │
│  └──────────────┬──────────────────────────────────────────────┘ │
│                 │                                                 │
│  ┌──────────────▼──────────────────────────────────────────────┐ │
│  │              Auth0 Service (server-side only)                │ │
│  │                                                              │ │
│  │  - getLoginUrl(connection)       Build Auth0 /authorize URL  │ │
│  │  - exchangeCodeForTokens(code)   POST Auth0 /oauth/token    │ │
│  │  - passwordLogin(email, pass)    Password-realm grant        │ │
│  │  - decodeIdToken(idToken)        Extract user profile        │ │
│  │  - verifyAccessToken(token)      JWKS verification           │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │             Dual-Strategy Auth Middleware                     │ │
│  │                                                               │ │
│  │  1. Try local JWT (jwt.verify with JWT_SECRET)                │ │
│  │  2. If fails, try Auth0 JWKS (RS256 verification)            │ │
│  │  3. Output: req.user = { id, email, name, role, teams }      │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │                     User Database                             │ │
│  │                                                               │ │
│  │  users table:                                                 │ │
│  │    + auth0_sub   (VARCHAR, unique, nullable)                  │ │
│  │    ~ password_hash  (now nullable for Auth0 users)            │ │
│  └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Auth0 Tenant (ASAP)                            │
│                                                                   │
│  Application: "ASAP KR-Sync"                                     │
│  Connections: google-oauth2, ORCID, Username-Password-Auth        │
│  JWKS endpoint: https://{domain}/.well-known/jwks.json            │
└──────────────────────────────────────────────────────────────────┘
```

---

## Configuration

### Environment Variables

Add these to your `.env` file (see `.env.example`):

```env
# Auth0 (ASAP Identity Provider)
AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_AUDIENCE=https://dev.hub.asap.science/api
AUTH0_CLIENT_ID=your_client_id
AUTH0_CLIENT_SECRET=your_client_secret
```

| Variable | Description | Required | Example |
|---|---|---|---|
| `AUTH0_DOMAIN` | Auth0 tenant domain | Yes | `asap-hub.us.auth0.com` |
| `AUTH0_AUDIENCE` | API audience identifier configured in Auth0 | Yes | `https://dev.hub.asap.science/api` |
| `AUTH0_CLIENT_ID` | Application client ID from Auth0 dashboard | Yes | `abc123def456...` |
| `AUTH0_CLIENT_SECRET` | Application client secret from Auth0 dashboard | Yes | `xyz789...` |
| `API_BASE_URL` | Public URL of the backend (used for Auth0 callback URL) | Yes | `https://krsync.asap.science` |
| `FRONTEND_URL` | Public URL of the frontend (redirect target after Auth0 callback) | Yes | `https://krsync.asap.science` |

### Auth0 Dashboard Configuration

On the Auth0 application settings page for "ASAP KR-Sync":

| Setting | Value |
|---|---|
| **Application Type** | Regular Web Application |
| **Allowed Callback URLs** | `{API_BASE_URL}/api/auth/auth0/callback` |
| **Allowed Logout URLs** | `{FRONTEND_URL}/login` |
| **Allowed Web Origins** | `{FRONTEND_URL}` |
| **Token Endpoint Auth Method** | Post |
| **Grant Types** | Authorization Code, Password (password-realm) |

### Connections to Enable

| Connection | Purpose |
|---|---|
| `google-oauth2` | Google social login for ASAP users |
| `ORCID` | ORCID institutional login |
| `Username-Password-Authentication` | Auth0-managed email/password (for password-realm grant) |

### Graceful Degradation

If Auth0 environment variables are not set, the integration is **silently disabled**:
- The `auth0Service.isConfigured()` check returns `false`
- Auth0 routes return a 502 error ("Auth0 is not configured")
- The auth middleware skips the Auth0 verification strategy
- The frontend ASAP Hub tab social/password login buttons will fail gracefully with an error message
- **The local DataSeer login continues to work normally**

---

## Authentication Flows

### Auth0 Social Login (Google / ORCID)

This is the OAuth 2.0 Authorization Code flow, handled entirely server-side.

```
User clicks              Backend                         Auth0
"Sign in with Google"
        │
        ▼
  GET /api/auth/auth0/login
  ?connection=google-oauth2
        │
        │              ┌─────────────┐
        └─────────────►│ Build Auth0 │
                       │ authorize   │
                       │ URL         │
                       └──────┬──────┘
                              │
                              │  302 Redirect
                              ▼
                    https://{domain}/authorize
                    ?response_type=code
                    &client_id=...
                    &redirect_uri=.../callback
                    &scope=openid profile email
                    &connection=google-oauth2
                              │
                              │  User authenticates
                              │  with Google
                              ▼
                    GET /api/auth/auth0/callback
                    ?code=AUTHORIZATION_CODE
                              │
                       ┌──────▼──────┐
                       │ Exchange    │
                       │ code for    │───────────► POST /oauth/token
                       │ tokens      │◄────────── {access_token, id_token}
                       └──────┬──────┘
                              │
                       ┌──────▼──────┐
                       │ Decode      │
                       │ ID token    │  Extract: sub, email, name
                       └──────┬──────┘
                              │
                       ┌──────▼──────────────┐
                       │ findOrCreateAuth0User│
                       │                     │
                       │ 1. Find by auth0Sub │
                       │ 2. Find by email    │
                       │    (link accounts)  │
                       │ 3. Create new user  │
                       └──────┬──────────────┘
                              │
                       ┌──────▼──────┐
                       │ Generate    │
                       │ local JWT   │  accessToken + refreshToken
                       │ tokens      │
                       └──────┬──────┘
                              │
                              │  Set-Cookie: asap_kr_session
                              │  Set-Cookie: asap_kr_refresh
                              │  Set-Cookie: asap_kr_csrf
                              │  302 Redirect
                              ▼
                    {FRONTEND_URL}/dashboard
                              │
                              │  Router beforeEach guard
                              │  initialize() → fetchCurrentUser()
                              │  (cookie travels automatically)
                              ▼
                    GET /api/auth/me → { user }
                    → user object stored in Pinia
                    → redirect to dashboard
```

**Cookie-based session delivery.** Since phase 6 the backend sets the
local JWT pair as `HttpOnly; Secure; SameSite=Strict` cookies on the
callback redirect response. Tokens never appear in the URL, in browser
history, or in JavaScript-readable storage. The SPA only knows about
the user object (returned by `GET /auth/me`); the access and refresh
tokens are completely opaque to it. CSRF is enforced via the third
cookie, `asap_kr_csrf` (JS-readable), which the SPA echoes back in the
`X-CSRF-Token` header on every state-changing request.

### Auth0 Password Login

This uses Auth0's Resource Owner Password Grant (password-realm), proxied through the backend. **The route is part of the contracted design — see the Overview note above.** ASAP enables the Password grant on the Auth0 application explicitly for this purpose, and the in-app email/password form on the ASAP Hub login tab is the primary path for ASAP users not using Google or ORCID.

Hardening this route is the only lever we have on this side: trust-proxy is set so the per-IP rate limit (`authLimiter`, 10/15min) actually applies, and brute-force protection on the password-realm grant is configured tenant-side by ASAP.

```
User fills ASAP Hub        Backend                       Auth0
email/password form
        │
        ▼
  POST /api/auth/auth0/login-password
  { email, password }
        │
        │              ┌─────────────┐
        └─────────────►│ Proxy to    │
                       │ Auth0       │───────────► POST /oauth/token
                       │ password-   │             grant_type=password-realm
                       │ realm grant │◄────────── {access_token, id_token}
                       └──────┬──────┘
                              │
                       ┌──────▼──────┐
                       │ Decode      │
                       │ ID token    │
                       └──────┬──────┘
                              │
                       ┌──────▼──────────────┐
                       │ findOrCreateAuth0User│
                       └──────┬──────────────┘
                              │
                       ┌──────▼──────┐
                       │ Generate    │
                       │ local JWT   │
                       └──────┬──────┘
                              │
                              │  Set-Cookie: asap_kr_session
                              │  Set-Cookie: asap_kr_refresh
                              │  Set-Cookie: asap_kr_csrf
                              ▼
                    { message: "Login successful", user }
                    (same shape as local login response — cookies on top)
```

The frontend handles this response identically to a local login — `setAuth()` stores the user object in the Pinia store. Tokens travel via the cookies set on the response and are never visible to JavaScript.

### Local (DataSeer) Login

Unchanged from the original implementation:

```
User fills DataSeer        Backend
email/password form
        │
        ▼
  POST /api/auth/login
  { email, password }
        │
        │              ┌──────────────┐
        └─────────────►│ Find user    │
                       │ by email     │
                       │              │
                       │ Verify       │
                       │ bcrypt hash  │
                       │              │
                       │ Generate     │
                       │ local JWT    │
                       └──────┬───────┘
                              │
                              ▼
                    { user, accessToken, refreshToken }
```

### Auth0 Callback Processing

The callback handler (`GET /api/auth/auth0/callback`) handles both success and error cases:

**Success path:**
1. Receive `?code=AUTHORIZATION_CODE`
2. Exchange code for tokens via Auth0 `/oauth/token`
3. Decode ID token to get user profile
4. Run `findOrCreateAuth0User()` logic
5. Generate local JWT pair
6. Set `asap_kr_session`, `asap_kr_refresh`, and `asap_kr_csrf` cookies on the redirect response
7. Redirect to `{FRONTEND_URL}/dashboard` (clean URL — no token in the hash since Phase 6)

**Error path (Auth0 returns error):**
1. Receive `?error=access_denied&error_description=...`
2. Redirect to `{FRONTEND_URL}/login?error={description}`
3. The LoginView displays the error via the notification store

**Error path (server error during processing):**
1. Any exception during code exchange or user creation
2. Log the error
3. Redirect to `{FRONTEND_URL}/login?error=Authentication+failed`

---

## User Account Lifecycle

### Auto-creation on First Login

When an Auth0 user logs in for the first time, the `findOrCreateAuth0User()` function executes the following strategy:

```
Auth0 profile: { sub: "google-oauth2|123", email: "user@asap.science", name: "Jane Doe" }

Step 1: SELECT * FROM users WHERE auth0_sub = 'google-oauth2|123'
        → Found? Return existing user. (Returning Auth0 user)

Step 2: SELECT * FROM users WHERE email = 'user@asap.science'
        → Found? Link: SET auth0_sub = 'google-oauth2|123', return user. (Account linking)

Step 3: INSERT INTO users (email, name, auth0_sub, role)
        VALUES ('user@asap.science', 'Jane Doe', 'google-oauth2|123', 'author')
        → Return new user. (Auto-created with default 'author' role)
```

### Account Linking by Email

If an existing local user (created via DataSeer registration) later logs in via Auth0 with the same email address:

1. The `auth0Sub` field is populated on their existing account
2. Their name is updated if it was just an email-derived placeholder
3. The user retains their existing role, teams, and submissions
4. From this point on, they can log in via **either** method (ASAP Hub or DataSeer)
5. However, if they log in via DataSeer, they use their local password; if via ASAP Hub, Auth0 handles authentication

### Auth0 vs Local Users

| Aspect | Local (DataSeer) User | Auth0 (ASAP Hub) User |
|---|---|---|
| `auth0Sub` field | `null` | `google-oauth2\|123...` or `auth0\|abc...` |
| `passwordHash` field | bcrypt hash | `null` (unless linked from existing local account) |
| `isAuth0User` flag (in API response) | `false` | `true` |
| Password change in profile | Allowed | Blocked ("managed by identity provider") |
| Login method | DataSeer tab → `POST /auth/login` | ASAP Hub tab → social buttons or `POST /auth/auth0/login-password` |
| Registration | Via `/register` page | Automatic on first Auth0 login |
| Token refresh | Standard refresh token flow | Standard refresh token flow (same local JWT) |

---

## Backend Implementation Details

### Auth0 Service

**File:** `src/backend/services/auth/auth0.service.js`

This service encapsulates all Auth0 HTTP communication. The frontend never talks to Auth0 directly.

| Function | Description | Auth0 Endpoint |
|---|---|---|
| `getLoginUrl(connection)` | Builds the Auth0 `/authorize` URL with client ID, redirect URI, scopes, and connection name | — (URL construction only) |
| `exchangeCodeForTokens(code)` | Exchanges an authorization code for access + ID tokens | `POST /oauth/token` (authorization_code grant) |
| `passwordLogin(email, password)` | Authenticates via Auth0 Resource Owner Password Grant | `POST /oauth/token` (password-realm grant) |
| `decodeIdToken(idToken)` | Decodes (without verification) the Auth0 ID token to extract `sub`, `email`, `name` | — (local JWT decode) |
| `verifyAccessToken(token)` | Verifies an Auth0 access token using JWKS (RS256) | `GET /.well-known/jwks.json` (cached) |
| `isConfigured()` | Returns `true` if all Auth0 env vars are set | — |

**JWKS Client configuration:**
- Signing keys are cached in memory
- Rate-limited to 5 JWKS requests per minute (prevents abuse)
- Lazy-initialized on first use

### Dual-Strategy Auth Middleware

**File:** `src/backend/middleware/auth.middleware.js`

The `authenticate` middleware now uses a two-step verification strategy:

```
Token from Authorization header
        │
        ▼
┌───────────────────────┐
│ 1. Try local JWT      │ jwt.verify(token, JWT_SECRET)
│    verification       │
│                       │──── Success ──► Lookup user by decoded.userId
│                       │                        │
│                       │──── Failure ──┐        ▼
└───────────────────────┘              │   req.user = userData
                                       │
                                       ▼
                              ┌─────────────────────┐
                              │ 2. Try Auth0 JWKS    │ auth0Service.verifyAccessToken(token)
                              │    verification      │
                              │    (if configured)   │
                              │                      │──── Success ──► Lookup user by decoded.sub
                              │                      │                        │
                              │                      │──── Failure ──┐        ▼
                              └──────────────────────┘              │   req.user = userData
                                                                    │
                                                                    ▼
                                                          AuthenticationError
                                                          "Invalid token"
```

The output shape is identical regardless of which strategy succeeds:

```js
req.user = {
  id: 'uuid',          // Local user ID
  email: 'user@...',
  name: 'Jane Doe',
  role: 'author',
  team: 'WH',          // Legacy single team
  teams: ['WH', 'JK'], // Multi-team array
  isAuth0User: true     // From toJSON()
}
req.userId = 'uuid'
```

### Auth0 Controller Methods

**File:** `src/backend/controllers/auth.controller.js`

Three new methods added alongside the existing five:

| Method | Route | Description |
|---|---|---|
| `auth0SocialLogin` | `GET /auth/auth0/login` | Validates `connection` query param, builds Auth0 authorize URL, redirects |
| `auth0PasswordLogin` | `POST /auth/auth0/login-password` | Validates email/password, proxies to Auth0, finds/creates user, returns local tokens |
| `auth0Callback` | `GET /auth/auth0/callback` | Exchanges code, finds/creates user, redirects to frontend with tokens in URL hash |

**`findOrCreateAuth0User(auth0Profile)` helper:**

This is the central user reconciliation function. It takes an Auth0 profile (`{ sub, email, name }`) and returns a local user, applying the three-step strategy described in [Account Linking](#account-linking-by-email).

### Auth0 Routes

**File:** `src/backend/routes/auth.routes.js`

| Method | Path | Rate Limit | Auth Required | Description |
|---|---|---|---|---|
| `GET` | `/api/auth/auth0/login` | `authLimiter` (10/15min) | No | Redirect to Auth0 authorize URL |
| `POST` | `/api/auth/auth0/login-password` | `authLimiter` (10/15min) | No | Proxy password to Auth0 |
| `GET` | `/api/auth/auth0/callback` | None | No | OAuth callback handler |

All existing routes are preserved unchanged.

### User Model Changes

**File:** `src/backend/models/User.js`

| Change | Before | After |
|---|---|---|
| `passwordHash` | `allowNull: false` | `allowNull: true` |
| `auth0Sub` | — (new) | `STRING(255), unique, nullable, field: 'auth0_sub'` |
| `toJSON()` | Deletes `passwordHash` | Also deletes `auth0Sub`, adds `isAuth0User: !!this.auth0Sub` |
| `verifyPassword()` | `bcrypt.compare(password, this.passwordHash)` | Returns `false` if `passwordHash` is null (Auth0 user) |

### Profile Protection

**File:** `src/backend/controllers/profile.controller.js`

In the `updateProfile` method, before processing a password change:

```js
if (newPassword) {
  if (user.auth0Sub) {
    throw new ValidationError('Password is managed by your identity provider');
  }
  // ... existing password change logic
}
```

This prevents Auth0 users from setting a local password, even via direct API calls.

---

## Frontend Implementation Details

### Login View (Tabbed UI)

**File:** `src/frontend/src/views/auth/LoginView.vue`

The login page presents two clearly separated tabs:

| Tab | Label | Contents | Auth Method |
|---|---|---|---|
| ASAP Hub | `activeTab === 'asap'` | Email/password form + "Or continue with" divider + Google button + ORCID button | `authStore.auth0PasswordLogin()` for form, `window.location.href` redirect for social buttons |
| DataSeer | `activeTab === 'local'` | Email/password form + Register link | `authStore.login()` |

Each tab has its own form refs (`asapEmail`/`asapPassword` vs `localEmail`/`localPassword`) so switching tabs doesn't clear user input.

The view also displays Auth0 callback errors from the `?error=` query parameter on mount.

### Auth Store

**File:** `src/frontend/src/stores/auth.store.js`

| Export | Type | Description |
|---|---|---|
| `isAuth0User` | Computed | `!!user.value?.auth0Sub` — true when the user has an Auth0 identity linked. |
| `auth0PasswordLogin(email, password)` | Action | Calls `authService.auth0PasswordLogin()`, then `setAuth()` to store the user object. Tokens are set as cookies by the backend response (Phase 6); the store does not touch them. Same loading/error handling as `login()`. |

**Removed in Phase 6:** the previous `handleAuth0Callback()` action (which extracted tokens from `window.location.hash` and wrote them to `localStorage`). The backend's `/api/auth/callback` now sets cookies on the redirect response and redirects to `/dashboard` with a clean URL — there is no hash to parse, and the SPA never sees the tokens.

### Auth Service

**File:** `src/frontend/src/services/auth.service.js`

New method:

```js
async auth0PasswordLogin(email, password) {
  const response = await api.post('/auth/auth0/login-password', { email, password })
  return response.data
}
```

### Router Guard

**File:** `src/frontend/src/router/index.js`

The `beforeEach` guard initialises the auth store on the first navigation:

```js
if (!authInitialized) {
  authInitialized = true
  try {
    await authStore.fetchCurrentUser()
  } catch (err) {
    // No valid session — gated routes redirect to /login below.
  }
}
```

`fetchCurrentUser()` does a `GET /api/auth/me`. The session cookie travels automatically; if it's valid we get a user object, otherwise we get 401 and stay logged out. The previous URL-hash callback handler was removed in Phase 6 because the backend redirects to a clean `/dashboard` after a successful Auth0 callback.

### API Interceptor

**File:** `src/frontend/src/services/api.js`

axios is configured with `withCredentials: true` so cookies travel on every request. The request interceptor injects an `X-CSRF-Token` header (read from the `asap_kr_csrf` JS-readable cookie) on every state-changing request. The response interceptor handles 401 by calling `/auth/refresh` once (deduped via a single in-flight promise), then retrying the original request — no body, no header rewriting; auth rides on the cookies. If the refresh itself 401s, `clearAuth()` runs and the SPA bounces to `/login`.

### Profile View

**File:** `src/frontend/src/views/profile/ProfileView.vue`

The "Change Password" card is conditionally rendered:

```html
<!-- Auth0 users: info message -->
<div v-if="authStore.isAuth0User" class="card">
  <h2>Password</h2>
  <p>Your password is managed by your identity provider.</p>
</div>

<!-- Local users: standard password change form -->
<div v-else class="card">
  <!-- Current password, new password, confirm password fields -->
</div>
```

---

## Database Migration

**File:** `migrations/20250101000022-add-auth0-support.js`

### Up Migration

```sql
-- Make password_hash nullable (Auth0 users don't have local passwords)
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Add auth0_sub column
ALTER TABLE users ADD COLUMN auth0_sub VARCHAR(255) UNIQUE;

-- Partial unique index (only for non-null values)
CREATE UNIQUE INDEX users_auth0_sub_unique ON users (auth0_sub) WHERE auth0_sub IS NOT NULL;
```

### Down Migration

```sql
DROP INDEX users_auth0_sub_unique;
ALTER TABLE users DROP COLUMN auth0_sub;
ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL;
```

### Running the Migration

```bash
cd src/backend
npx sequelize-cli db:migrate
```

**Note:** The down migration will fail if any Auth0 users exist (rows with `NULL` password_hash). You would need to either delete those users or assign them a placeholder password hash before rolling back.

---

## API Reference

### Auth0 Endpoints

#### `GET /api/auth/auth0/login`

Redirect the user to Auth0 for social login.

**Query Parameters:**

| Parameter | Required | Description | Example |
|---|---|---|---|
| `connection` | Yes | Auth0 connection name | `google-oauth2`, `ORCID` |

**Response:** `302 Redirect` to Auth0 `/authorize` URL

**Errors:**

| Status | Error | Cause |
|---|---|---|
| 400 | `Connection parameter is required` | Missing `connection` query param |
| 502 | `Auth0 is not configured` | Auth0 env vars not set |

---

#### `POST /api/auth/auth0/login-password`

Authenticate via Auth0 using email and password (Resource Owner Password Grant).

**Request Body:**

```json
{
  "email": "user@asap.science",
  "password": "their-auth0-password"
}
```

**Success Response (200):**

```json
{
  "message": "Login successful",
  "user": {
    "id": "uuid",
    "email": "user@asap.science",
    "name": "Jane Doe",
    "role": "author",
    "team": null,
    "isAuth0User": true,
    "createdAt": "...",
    "updatedAt": "..."
  },
  "accessToken": "eyJhbGciOi...",
  "refreshToken": "eyJhbGciOi...",
  "expiresIn": "7d"
}
```

**Errors:**

| Status | Error | Cause |
|---|---|---|
| 400 | `Email and password are required` | Missing fields |
| 401 | `Invalid email or password` | Auth0 rejected credentials |
| 502 | `Auth0 is not configured` | Auth0 env vars not set |
| 502 | `Auth0 authentication failed` | Auth0 service error |

---

#### `GET /api/auth/auth0/callback`

OAuth callback handler. Not called directly by the frontend — Auth0 redirects here after social login.

**Query Parameters (success):**

| Parameter | Description |
|---|---|
| `code` | Authorization code from Auth0 |

**Query Parameters (error):**

| Parameter | Description |
|---|---|
| `error` | Error code from Auth0 |
| `error_description` | Human-readable error description |

**Success Response:** `302 Redirect` to `{FRONTEND_URL}/dashboard` with `Set-Cookie` headers for `asap_kr_session`, `asap_kr_refresh`, and `asap_kr_csrf`. (Phase 6: tokens no longer travel via the URL hash.)

**Error Response:** `302 Redirect` to `{FRONTEND_URL}/login?error={description}`

---

## Security Considerations

### Token Security

- **Auth0 tokens are never exposed to the frontend.** The callback exchanges the authorization code server-side and returns local JWT tokens instead.
- **URL hash for token transport.** Hash fragments are not sent in HTTP requests, preventing token leakage in server logs or referrer headers. The frontend clears the hash immediately after extraction.
- **Auth0 client secret is server-side only.** It is never included in frontend bundles or exposed via API responses.

### Auth0 Token Verification

- **JWKS-based verification** uses RS256 asymmetric signatures. The signing key is fetched from Auth0's `/.well-known/jwks.json` endpoint.
- **Key caching** prevents excessive calls to Auth0's JWKS endpoint. Keys are cached in memory with a rate limit of 5 requests per minute.
- **Audience and issuer validation** ensures tokens were issued for this specific application by the expected Auth0 tenant.

### Account Linking Security

- **Email-based linking** assumes that Auth0-verified emails are trustworthy. Auth0 verifies email ownership during the social login flow.
- **One-time linking.** Once `auth0Sub` is set on a user, subsequent Auth0 logins match by `auth0Sub` first (faster and more reliable than email matching).

### Password Protection

- **Auth0 users cannot set local passwords** — the profile controller explicitly rejects password changes for users with `auth0Sub`.
- **The `auth0Sub` field is never exposed in API responses** — it is stripped in `toJSON()`. Only the boolean `isAuth0User` flag is returned.

### Rate Limiting

- Auth0 social login and password login routes use the same `authLimiter` (10 requests per 15 minutes per IP) as local login, preventing brute-force attacks.
- The callback route has no rate limit since it is triggered by Auth0 redirects (not user-initiated requests).

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|---|---|---|
| "Auth0 is not configured" error | Missing Auth0 env vars | Set `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` in `.env` |
| Callback returns "Authentication failed" | Incorrect callback URL in Auth0 dashboard | Verify `Allowed Callback URLs` matches `{API_BASE_URL}/api/auth/auth0/callback` |
| Social login redirects but callback fails | `AUTH0_CLIENT_SECRET` is wrong | Regenerate secret in Auth0 dashboard and update `.env` |
| "Invalid email or password" on ASAP Hub password login | User doesn't exist in Auth0 or wrong password | Verify the user exists in Auth0's user management |
| Auth0 user can't access submissions | User auto-created with `author` role, no teams assigned | Admin must assign appropriate role and teams |
| "Token expired" on Auth0 JWKS verification | Auth0 access token (not local JWT) expired | This only happens if the auth middleware is verifying an Auth0 token directly. Normal flow uses local JWTs. |
| ORCID login not working | ORCID connection not configured in Auth0 | Enable the ORCID social connection in Auth0 dashboard |
| Duplicate user after Auth0 login | Auth0 email differs from local email (case, alias) | Emails are auto-lowercased. If different, manually link by setting `auth0_sub` in the database. |

### Checking Auth0 Logs

Auth0 provides detailed logs in the dashboard under **Monitoring > Logs**. Filter by:
- `type:s` (successful logins)
- `type:f` (failed logins)
- `type:seacft` (successful exchange of authorization code for tokens)

### Verifying Configuration

```bash
# Check if Auth0 env vars are set (don't log the actual values!)
node -e "
  const vars = ['AUTH0_DOMAIN', 'AUTH0_AUDIENCE', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET'];
  vars.forEach(v => console.log(v + ':', process.env[v] ? 'SET' : 'MISSING'));
"
```

---

## Testing Checklist

### Local (DataSeer) Authentication (Regression)

- [ ] Email/password login works via the DataSeer tab
- [ ] Registration creates a new local user
- [ ] Token refresh works (wait for expiry or manually expire)
- [ ] Logout clears session
- [ ] Profile page shows password change form for local users
- [ ] Password change works for local users

### Auth0 Social Login

- [ ] "Sign in with Google" redirects to Auth0/Google
- [ ] After Google auth, callback redirects to dashboard
- [ ] New user is auto-created with `author` role
- [ ] Returning user is recognized by `auth0Sub`
- [ ] URL hash is cleared after token extraction

### Auth0 Password Login

- [ ] ASAP Hub email/password form authenticates via Auth0
- [ ] Returns local JWT tokens (same format as local login)
- [ ] Invalid credentials show error message

### Account Linking

- [ ] Existing local user logs in via Auth0 with same email → `auth0Sub` is set
- [ ] Linked user can still log in via DataSeer tab with local password
- [ ] Linked user shows `isAuth0User: true` in profile

### Profile Protection

- [ ] Auth0 user sees "managed by identity provider" message on profile
- [ ] Auth0 user does NOT see password change form
- [ ] Direct API call to change password for Auth0 user returns 400 error
- [ ] Local user still sees and can use password change form

### Error Handling

- [ ] Auth0 callback with error redirects to login with error message
- [ ] Auth0 callback without code redirects to login with error message
- [ ] Missing Auth0 config returns 502 on Auth0 routes
- [ ] Local auth routes are unaffected by Auth0 config state

### Edge Cases

- [ ] Two Auth0 users with different `sub` but same email → second user links to first
- [ ] Auth0 user with no name → falls back to nickname or email prefix
- [ ] Concurrent Auth0 and local login attempts don't interfere
- [ ] Browser back button after Auth0 callback doesn't replay token extraction
