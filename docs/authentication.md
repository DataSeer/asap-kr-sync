# Authentication

The application supports two authentication methods: **local JWT** (email/password) and **Auth0** (OAuth2/OIDC). Both methods produce local JWT tokens for API access, providing a uniform token format across all auth flows.

## JWT Token Flow

Since Phase 6 the local JWT pair is delivered via **HttpOnly cookies**, never via the response body or URL hash. The frontend SPA never sees the raw tokens.

### Cookies set by the backend

| Cookie | Lifetime | Flags | Purpose |
|-------|----------|-------|---------|
| `asap_kr_session` | `JWT_EXPIRES_IN` (default `15m`) | `HttpOnly; Secure*; SameSite=Strict; Path=/api` | Access JWT. Read server-side on every authenticated request. |
| `asap_kr_refresh` | `JWT_REFRESH_EXPIRES_IN` (default `7d`) | `HttpOnly; Secure*; SameSite=Strict; Path=/api/auth/refresh` | Refresh JWT. Only travels to the refresh endpoint. |
| `asap_kr_csrf` | matches the session cookie | `Secure*; SameSite=Strict; Path=/` (not HttpOnly — JS reads it) | CSRF double-submit token. SPA echoes it back in `X-CSRF-Token` on every state-changing request. |

\* `Secure` is set when `NODE_ENV=production` or `FRONTEND_URL` is HTTPS.

### Access Token Payload

```json
{
  "userId": "UUID",
  "email": "user@example.com",
  "role": "author | asap_pm | ds_annotator | admin",
  "iat": 1234567890,
  "exp": 1234567890
}
```

### Refresh Token Payload

```json
{
  "userId": "UUID",
  "type": "refresh",
  "iat": 1234567890,
  "exp": 1234567890
}
```

Refresh tokens are also persisted in the `refresh_tokens` table (sha256 hash, expiry, user agent, IP, optional `revoked_at`/`revoked_reason`/`replaced_by`). Each refresh rotates the pair atomically and revokes the predecessor with `revoked_reason='rotation'`; reuse of an already-rotated token is treated as a compromise signal and revokes the entire chain.

### Automatic Token Refresh

The frontend Axios interceptor (`src/frontend/src/services/api.js`) handles 401 responses by:

1. Checking if the request was already retried (`_retry` flag)
2. De-duping concurrent failures behind a single in-flight `POST /api/auth/refresh` call — no body, the refresh cookie travels automatically
3. Retrying the original request (cookies travel automatically; no header rewriting)
4. On refresh failure: calling `authStore.clearAuth()` and redirecting to `/login`

## Auth0 Integration

Auth0 acts as an external identity provider. The backend handles all Auth0 communication — the frontend never interacts with Auth0 directly.

### Configuration

| Variable | Description |
|----------|-------------|
| `AUTH0_ENABLED` | Feature flag (`true`/`false`) |
| `AUTH0_DOMAIN` | Auth0 tenant domain (e.g., `your-tenant.us.auth0.com`) |
| `AUTH0_AUDIENCE` | API audience identifier |
| `AUTH0_CLIENT_ID` | Application client ID |
| `AUTH0_CLIENT_SECRET` | Application client secret |

### Social Login Flow (Google, ORCID)

```
1. User clicks social login button
2. Frontend redirects to GET /api/auth/auth0/login?connection=google-oauth2
3. Backend generates state, nonce, codeVerifier+codeChallenge (PKCE);
   stores all three in short-lived HttpOnly flow cookies
4. Backend redirects to Auth0 /authorize URL (with code_challenge_method=S256)
5. User authenticates with social provider
6. Auth0 redirects to GET /api/auth/callback?code=AUTHORIZATION_CODE&state=...
7. Backend validates state against the flow cookie, exchanges code with PKCE,
   verifies ID token signature (JWKS / RS256), validates the nonce claim
8. Backend finds or creates local user (see Account Linking below)
9. Backend generates LOCAL JWT pair
10. Backend sets asap_kr_session, asap_kr_refresh, asap_kr_csrf cookies
    and redirects 302 to {FRONTEND_URL}/dashboard (clean URL — no hash)
11. Frontend router guard calls GET /api/auth/me; cookies travel
    automatically and the user object lands in the Pinia store
```

### Auth0 Password Login

```
1. User submits email/password form
2. Frontend calls POST /api/auth/auth0/login-password
3. Backend proxies to Auth0 Resource Owner Password Grant
4. Same as steps 7-9 above: find/create user, generate local JWTs
5. Backend sets the three auth cookies; response body is { message, user }
   — tokens never appear in the body
```

### Account Linking

When a user authenticates via Auth0 for the first time:

1. **Find by `auth0Sub`** — returning Auth0 user
2. **Find by email** — links existing local account by setting `auth0Sub`
3. **Create new user** — auto-created with `author` role

Once linked, users can log in via either method. The `isAuth0User` flag (true if `auth0Sub` is set) is sent to the frontend to customize the UI (e.g., hiding the password change form for Auth0-only users).

### JWKS Verification

Auth0 access tokens are verified using RS256 asymmetric signing:

- Public keys fetched from Auth0's `/.well-known/jwks.json`
- Keys cached in memory
- Rate-limited to 5 JWKS requests per minute
- Audience and issuer validated

## User Roles

| Role | Access Level |
|------|-------------|
| `author` | Own submissions only |
| `asap_pm` | Submissions from assigned teams |
| `ds_annotator` | All submissions, user/team management |
| `admin` | Full system access, app configuration |

### Role Hierarchy for Route Access

| Route | Required Roles |
|-------|---------------|
| `/admin/users` | admin, ds_annotator, asap_pm |
| `/admin/teams` | admin, ds_annotator |
| `/admin/krt-editor/resource-types` | admin, ds_annotator |
| `/admin/enrichments` | admin, ds_annotator |
| `/admin/krt-editor/validation-rules` | admin |

## Middleware Chain

Requests pass through middleware in this order:

```
Request
  → helmet()                    Security headers
  → cors()                      Cross-origin (FRONTEND_URL, credentials)
  → express.json()              Body parsing (10MB limit)
  → cookie-parser()             Parses asap_kr_session / asap_kr_refresh / asap_kr_csrf
  → morgan()                    Request logging
  → Route matching
  → csrfProtect                 Double-submit CSRF check (state-changing /api/* calls)
  → Rate limiting (per-route)   See rate limits below
  → authenticate                Cookie verification, sets req.user
  → requireRole(...)            Role-based access check
  → canAccessSubmission         Submission-level access check
  → Controller
  → errorMiddleware             Centralized error handling
```

### Authentication Middleware

- Reads the JWT from the `asap_kr_session` cookie only — no `Authorization` header support since Phase 6.2
- Tries local-JWT verification first; falls back to Auth0 JWKS (RS256) verification when the local secret rejects the token
- Attaches `req.user` (`{ id, email, name, role, auth0Sub, teams[], isAuth0User }`) and `req.userId`
- Throws `AuthenticationError` (401) if the cookie is missing or invalid

### Role Middleware

- `requireRole(...allowedRoles)` — checks `req.user.role` against allowed list
- `requireAdmin()` — shorthand for admin-only routes
- Returns `AuthorizationError` (403) if role doesn't match

### Team Middleware

- `canAccessSubmission` — granular per-submission access control:
  - **admin / ds_annotator**: access all submissions
  - **asap_pm**: access submissions from assigned teams
  - **author**: access only own submissions
- `buildSubmissionFilter` — applies role-based filtering to submission queries

## Rate Limiting

Rate limit configuration is in `conf/rate-limits.json`.

| Limiter | Applies To | Limit | Window |
|---------|-----------|-------|--------|
| `authLimiter` | Login, register, Auth0 endpoints | 10 requests | 15 min / IP |
| `refreshLimiter` | Token refresh | 30 requests | 1 min / IP |
| `apiLimiter` | General API endpoints | 200 requests | 1 min / IP |
| `uploadLimiter` | File uploads | 20 requests | 1 min / user |
| `lmApiLimiter` | AI analysis operations | 10 requests | 1 min / user |

Authenticated users bypass `apiLimiter`. Auth endpoints are always rate-limited.

## Frontend Route Protection

The Vue Router `beforeEach` guard enforces:

1. **Session restoration** — on first navigation, calls `GET /api/auth/me`. Cookies travel automatically; a successful response populates the store, a 401 leaves the user unauthenticated. (Phase 6 removed the previous URL-hash extraction step — there is no hash to parse.)
2. **Authentication** — redirects to `/login` if the route requires auth and the user is not authenticated
3. **Role check** — redirects to `/dashboard` if the user's `effectiveRole` doesn't match the route's `meta.roles`
4. **Guest check** — redirects authenticated users away from `/login` and `/register`

### Admin "View As" Feature

Admins can simulate other roles using `authStore.setViewAsRole(role)`. This changes `effectiveRole` for UI rendering and route guards without affecting actual backend permissions.

## Key Files

| File | Purpose |
|------|---------|
| `src/backend/services/auth/auth.service.js` | Core auth logic (login, register, find/create) |
| `src/backend/services/auth/auth0.service.js` | Auth0 integration (token exchange, JWKS) |
| `src/backend/services/auth/jwt.service.js` | JWT generation and verification |
| `src/backend/middleware/auth.middleware.js` | Token verification middleware |
| `src/backend/middleware/role.middleware.js` | Role-based access control |
| `src/backend/middleware/team.middleware.js` | Team-based submission access |
| `src/backend/middleware/rate-limit.middleware.js` | Rate limiting |
| `src/backend/routes/auth.routes.js` | Auth route definitions |
| `src/backend/controllers/auth.controller.js` | Auth request handlers |
| `src/frontend/src/stores/auth.store.js` | Frontend auth state management |
| `src/frontend/src/services/api.js` | Axios instance with token interceptors |
| `src/frontend/src/router/index.js` | Route guards |
| `conf/rate-limits.json` | Rate limit configuration |
