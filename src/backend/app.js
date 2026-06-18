/**
 * ASAP KR-Sync - Express Application Setup
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const routes = require('./routes');
const errorMiddleware = require('./middleware/error.middleware');
const { csrfProtect } = require('./middleware/csrf.middleware');
const { apiLimiter } = require('./middleware/rate-limit.middleware');
const logger = require('./utils/logger');

const SPA_DIST_PATH = path.resolve(__dirname, '..', 'frontend', 'dist');

const app = express();

// Trust the first reverse proxy hop (nginx). Required so req.ip resolves to
// the real client IP from X-Forwarded-For rather than the nginx loopback,
// which is critical for per-IP rate limiters on /api/auth/* and /api/auth/auth0/*.
app.set('trust proxy', 1);

// Security middleware. Explicit CSP tuned for the Vite/Vue SPA this app serves:
// scripts are bundled (self, no inline), Vue injects component styles inline
// (style 'unsafe-inline'), images may be data:/blob: (base64 + generated
// downloads), and the SPA only talks to its own /api origin. File downloads use
// window.open() to S3 presigned URLs (top-level navigation, not governed here).
// If you later embed S3 content in an <iframe>/<img> or add a CDN/Auth0 fetch,
// extend frame-src/img-src/connect-src accordingly.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  }
}));

// Defense in depth: helmet already removes this, but disable it explicitly so
// the server tech isn't advertised even if helmet config changes.
app.disable('x-powered-by');

// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Note: Rate limiting is applied per-route in the routes files
// This allows authenticated users to bypass API rate limits while
// still protecting auth endpoints from brute force attacks

// Request parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Parses cookies into req.cookies. Required by the Auth0 OAuth flow which
// stores short-lived state, nonce, and PKCE verifier cookies between the
// authorize redirect and the callback.
app.use(cookieParser());

// Request logging
const morganFormat = process.env.NODE_ENV === 'production' ? 'combined' : 'dev';
app.use(morgan(morganFormat, {
  stream: { write: (message) => logger.http(message.trim()) }
}));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Baseline DoS protection on the whole API surface (200 req/min/IP from
// conf/rate-limits.json). Auth/upload/LM endpoints add their own stricter,
// per-user limiters on top. Tune the `api` limit if shared-NAT offices hit it.
app.use('/api', apiLimiter);

// CSRF protection (double-submit cookie pattern). Runs before routes so
// every state-changing request to /api is checked. Login / refresh / Auth0
// callback are exempted inside the middleware (they bootstrap the cookie).
app.use('/api', csrfProtect);

// API routes
app.use('/api', routes);

// Demo files are runtime-mounted (read-only) at src/frontend/public/demo-files
// in the container — they are NOT bundled into dist/ because the production
// build context excludes the binaries via .dockerignore. Serve them from the
// public path directly, BEFORE the SPA static + catch-all handler so the
// catch-all doesn't return index.html instead of the requested CSV/PDF.
const DEMO_FILES_PATH = path.resolve(__dirname, '..', 'frontend', 'public', 'demo-files');
if (fs.existsSync(DEMO_FILES_PATH)) {
  logger.info(`Serving demo files from ${DEMO_FILES_PATH}`);
  app.use('/demo-files', express.static(DEMO_FILES_PATH, {
    fallthrough: false,
    index: false,
    redirect: false,
  }));
}

// Serve Vue SPA static files in production
if (fs.existsSync(SPA_DIST_PATH)) {
  logger.info(`Serving static files from ${SPA_DIST_PATH}`);
  app.use(express.static(SPA_DIST_PATH));

  // SPA fallback: serve index.html for any non-API route (Vue Router history mode).
  // Skip /api/* and /demo-files/* so missing endpoints/assets return a clean 404
  // instead of an HTML body that callers (e.g. demo-file fetchers) might mistake
  // for a real file and re-upload as garbage.
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/demo-files/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(SPA_DIST_PATH, 'index.html'));
  });
} else {
  // 404 handler (development — frontend served separately)
  app.use((req, res, next) => {
    res.status(404).json({ error: 'Not found' });
  });
}

// Error handling middleware
app.use(errorMiddleware);

module.exports = app;
