# Authentication

The application supports two authentication methods: **local JWT** (email/password) and **Auth0** (OAuth2/OIDC). Both methods produce local JWT tokens for API access, providing a uniform token format across all auth flows.

## JWT Token Flow

### Token Types

| Token | Lifetime | Storage | Purpose |
|-------|----------|---------|---------|
| Access token | 7 days (`JWT_EXPIRES_IN`) | `localStorage.token` | API authorization via `Authorization: Bearer` header |
| Refresh token | 30 days (`JWT_REFRESH_EXPIRES_IN`) | `localStorage.refreshToken` | Obtain new access token when expired |

### Access Token Payload

```json
{
  "userId": "UUID",
  "email": "user@example.com",
  "role": "author | asap_pm | ds_annotator | admin",
  "team": "XX",
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

### Automatic Token Refresh

The frontend Axios interceptor handles 401 responses by:

1. Checking if the request was already retried
2. Sending the refresh token to `POST /api/auth/refresh`
3. Updating both tokens in localStorage
4. Retrying the original request with the new access token
5. Redirecting to login if refresh fails

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
3. Backend redirects to Auth0 authorize URL
4. User authenticates with social provider
5. Auth0 redirects to GET /api/auth/auth0/callback?code=AUTHORIZATION_CODE
6. Backend exchanges code for Auth0 tokens (POST to Auth0 /oauth/token)
7. Backend extracts user profile from Auth0 ID token (sub, email, name)
8. Backend finds or creates local user (see Account Linking below)
9. Backend generates LOCAL JWT tokens
10. Backend redirects to {FRONTEND_URL}/dashboard#access_token=...&refresh_token=...
11. Frontend router guard extracts tokens from URL hash
```

### Auth0 Password Login

```
1. User submits email/password form
2. Frontend calls POST /api/auth/auth0/login-password
3. Backend proxies to Auth0 Resource Owner Password Grant
4. Same as steps 7-9 above: find/create user, generate local JWTs
5. Returns tokens in response body
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
| `/admin/resource-types` | admin, ds_annotator |
| `/admin/software-list` | admin, ds_annotator |
| `/admin/config` | admin |

## Middleware Chain

Requests pass through middleware in this order:

```
Request
  → helmet()                    Security headers
  → cors()                      Cross-origin (FRONTEND_URL)
  → express.json()              Body parsing
  → morgan()                    Request logging
  → Route matching
  → Rate limiting (per-route)   See rate limits below
  → authenticate                Token verification, sets req.user
  → requireRole(...)            Role-based access check
  → canAccessSubmission         Submission-level access check
  → Controller
  → errorMiddleware             Centralized error handling
```

### Authentication Middleware

- Extracts token from `Authorization: Bearer` header
- Verifies JWT signature and expiry
- Attaches `req.user` (user object) and `req.userId`
- Throws `AuthenticationError` (401) if token is invalid or missing

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

1. **Auth0 callback** — extracts tokens from URL hash after OAuth redirect
2. **Token restoration** — fetches current user on first navigation if token exists
3. **Authentication** — redirects to `/login` if route requires auth and user is not authenticated
4. **Role check** — redirects to `/dashboard` if user's `effectiveRole` doesn't match route's `meta.roles`
5. **Guest check** — redirects authenticated users away from login/register pages

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
